require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cron = require('node-cron');
const chrono = require('chrono-node');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Environment variables validation
const requiredEnvVars = {
  VERIFY_TOKEN: process.env.VERIFY_TOKEN,
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER: process.env.TWILIO_PHONE_NUMBER,
  MONGODB_URI: process.env.MONGODB_URI,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY
};

const missingVars = Object.entries(requiredEnvVars)
  .filter(([key, value]) => !value)
  .map(([key]) => key);

if (missingVars.length > 0) {
  console.error('Missing required environment variables:', missingVars);
  if (process.env.NODE_ENV !== 'production') {
    process.exit(1);
  }
}

// MongoDB connection
async function connectToMongoDB() {
  const maxRetries = 5;
  let retries = 0;
  
  while (retries < maxRetries) {
    try {
      await mongoose.connect(process.env.MONGODB_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
        serverSelectionTimeoutMS: 10000,
        socketTimeoutMS: 45000,
      });
      console.log('Connected to MongoDB');
      return;
    } catch (err) {
      retries++;
      console.error(`MongoDB connection attempt ${retries} failed:`, err.message);
      
      if (retries >= maxRetries) {
        console.error('Max retries reached. Could not connect to MongoDB.');
        return;
      }
      
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

connectToMongoDB();

// User Schema
const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  userName: { type: String, required: true },
  preferredName: { type: String, default: null },
  location: { type: String, default: null },
  timezoneOffset: { type: Number, default: 0 },
  messageCount: { type: Number, default: 0 },
  lastResetDate: { type: Date, default: Date.now },
  isSetup: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// Reminder Schema
const reminderSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  userName: { type: String, required: true },
  message: { type: String, required: true },
  scheduledTime: { type: Date, required: true },
  userLocalTime: { type: String, required: true },
  isCompleted: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const Reminder = mongoose.model('Reminder', reminderSchema);

// Usage limits
const USAGE_LIMITS = {
  FREE_TIER_MESSAGES: 50,
  RESET_PERIOD_HOURS: 24
};

async function checkUsageLimits(user) {
  const now = new Date();
  const timeSinceReset = now - user.lastResetDate;
  const hoursElapsed = timeSinceReset / (1000 * 60 * 60);
  
  if (hoursElapsed >= USAGE_LIMITS.RESET_PERIOD_HOURS) {
    user.messageCount = 0;
    user.lastResetDate = now;
    await user.save();
  }
  
  return {
    withinLimit: user.messageCount < USAGE_LIMITS.FREE_TIER_MESSAGES,
    remainingMessages: Math.max(0, USAGE_LIMITS.FREE_TIER_MESSAGES - user.messageCount)
  };
}

// Fixed ChatGPT function
async function askChatGPT(prompt, systemMessage) {
  try {
    console.log('🤖 ChatGPT analyzing...');
    
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemMessage },
          { role: 'user', content: prompt }
        ],
        max_tokens: 250,
        temperature: 0.3
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 8000
      }
    );
    
    const result = response.data.choices[0].message.content.trim();
    console.log('🤖 ChatGPT responded');
    
    // Try to parse as JSON, fallback if fails
    try {
      return JSON.parse(result);
    } catch {
      return { raw: result };
    }
  } catch (error) {
    console.error('🚨 ChatGPT Error:', error.message);
    return null;
  }
}

// Smart reminder analyzer
async function analyzeReminder(messageText, userName) {
  const systemMessage = `You are Jarvis, a direct and efficient reminder assistant. Analyze messages for reminder tasks.

User message: "${messageText}"

Respond with JSON only:
{
  "isReminder": true/false,
  "task": "clean task description",
  "timeFound": true/false,
  "timeExpression": "time if found",
  "motivation": "short motivational phrase (max 4 words)",
  "needsTime": true/false
}

Examples:
- "gym at 7pm" → {"isReminder": true, "task": "gym", "timeFound": true, "timeExpression": "7pm", "motivation": "Stay strong! 💪", "needsTime": false}
- "call mom" → {"isReminder": true, "task": "call mom", "timeFound": false, "motivation": "Family matters! 💕", "needsTime": true}
- "vitamin morning" → {"isReminder": true, "task": "take vitamin", "timeFound": true, "timeExpression": "morning", "motivation": "Health first! 🌟", "needsTime": false}

Be direct and precise.`;

  try {
    const result = await askChatGPT(messageText, systemMessage);
    return result || { isReminder: false };
  } catch (error) {
    console.error('Error analyzing reminder:', error);
    return { isReminder: false };
  }
}

// Location timezone detection
async function detectLocationTimezone(location) {
  const systemMessage = `You are a timezone expert. Determine timezone offset from UTC for the given location.

Location: "${location}"

Respond with JSON only:
{
  "timezoneOffset": 3,
  "location": "Istanbul, Turkey",
  "confirmation": "Turkey timezone (GMT+3) set!"
}

Examples:
- "Istanbul" → {"timezoneOffset": 3, "location": "Istanbul, Turkey", "confirmation": "Turkey timezone (GMT+3) set!"}
- "New York" → {"timezoneOffset": -5, "location": "New York, USA", "confirmation": "Eastern timezone (GMT-5) set!"}
- "London" → {"timezoneOffset": 0, "location": "London, UK", "confirmation": "GMT timezone set!"}`;

  try {
    const result = await askChatGPT(location, systemMessage);
    return result;
  } catch (error) {
    console.error('Error detecting timezone:', error);
    return null;
  }
}

// Check for name change
function isNameChange(messageText) {
  const text = messageText.toLowerCase();
  if ((text.includes('call me') || text.includes('name') || text.includes('i am') || text.includes("i'm")) && 
      !text.includes('remind') && !text.includes('at ') && !text.includes('tomorrow')) {
    
    let newName = text;
    if (text.includes('call me')) {
      newName = text.split('call me')[1];
    } else if (text.includes('my name is')) {
      newName = text.split('my name is')[1];
    } else if (text.includes('i am')) {
      newName = text.split('i am')[1];
    } else if (text.includes("i'm")) {
      newName = text.split("i'm")[1];
    }
    
    newName = newName.replace(/[^a-zA-Z\s]/g, '').trim();
    
    if (newName && newName.length > 0 && newName.length < 20) {
      return newName;
    }
  }
  return null;
}

// Twilio WhatsApp function
async function sendWhatsAppMessage(to, message) {
  try {
    const authToken = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    
    const response = await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
      new URLSearchParams({
        From: `whatsapp:${process.env.TWILIO_PHONE_NUMBER}`,
        To: `whatsapp:${to}`,
        Body: message
      }),
      {
        headers: {
          'Authorization': `Basic ${authToken}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 10000
      }
    );
    
    console.log('✅ Message sent');
    return response.data;
  } catch (error) {
    console.error('❌ Send error:', error.message);
    throw error;
  }
}

// Enhanced reminder parsing
function parseReminderWithTimezone(messageText, task, timezoneOffset = 0) {
  try {
    let parsed = chrono.parseDate(messageText);
    
    // Smart defaults
    if (!parsed) {
      if (messageText.toLowerCase().includes('morning')) {
        const morning = new Date();
        morning.setHours(8, 0, 0, 0);
        if (morning <= new Date()) {
          morning.setDate(morning.getDate() + 1);
        }
        parsed = morning;
      } else if (messageText.toLowerCase().includes('evening')) {
        const evening = new Date();
        evening.setHours(18, 0, 0, 0);
        if (evening <= new Date()) {
          evening.setDate(evening.getDate() + 1);
        }
        parsed = evening;
      } else if (messageText.toLowerCase().includes('tomorrow')) {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(9, 0, 0, 0);
        parsed = tomorrow;
      }
    }
    
    if (!parsed) return null;
    
    // Convert to UTC for storage
    const utcTime = new Date(parsed.getTime() - (timezoneOffset * 60 * 60 * 1000));
    
    return {
      message: task,
      scheduledTime: utcTime,
      userLocalTime: parsed.toLocaleString()
    };
  } catch (error) {
    console.error('Error parsing reminder:', error);
    return null;
  }
}

// Webhook verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token && mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    console.log('✅ Webhook verified');
    res.status(200).send(challenge);
  } else {
    console.error('❌ Webhook verification failed');
    res.sendStatus(403);
  }
});

// Webhook for receiving messages
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    if (body.From && body.Body) {
      const phoneNumber = body.From.replace('whatsapp:', '');
      
      const message = {
        from: phoneNumber,
        text: { body: body.Body },
        type: 'text'
      };
      
      const contact = {
        wa_id: phoneNumber,
        profile: { name: body.ProfileName || 'User' }
      };
      
      await handleIncomingMessage(message, contact);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.sendStatus(500);
  }
});

// MAIN message handler - NO multiple responses
async function handleIncomingMessage(message, contact) {
  try {
    const userId = message.from;
    const userName = contact?.profile?.name || 'User';
    const messageText = message.text.body;

    console.log(`📨 ${userName}: ${messageText}`);

    // Find or create user
    let user = await User.findOne({ userId });
    if (!user) {
      user = new User({
        userId,
        userName,
        isSetup: false
      });
      await user.save();
    }

    // Check usage limits
    const usageCheck = await checkUsageLimits(user);
    if (!usageCheck.withinLimit) {
      await sendWhatsAppMessage(userId, `🚫 Daily limit reached (${USAGE_LIMITS.FREE_TIER_MESSAGES} messages).\n\n⭐ Upgrade for unlimited reminders!`);
      return;
    }

    // Increment message count
    user.messageCount += 1;
    await user.save();

    // Setup flow
    if (!user.isSetup) {
      if (!user.preferredName) {
        // Welcome + name
        await sendWhatsAppMessage(userId, `🤖 Hi! I'm Jarvis, your reminder assistant.\n\n📋 I help you remember things with SPECIFIC times:\n\n✅ "gym at 7pm today"\n✅ "call mom at 3pm tomorrow"\n❌ "gym tonight" (too vague)\n❌ "call mom tomorrow" (no time)\n\nWhat should I call you?`);
        
        // Try to extract name from current message
        const cleanName = messageText.replace(/[^a-zA-Z\s]/g, '').trim();
        if (cleanName && cleanName.length > 0 && cleanName.length < 20) {
          user.preferredName = cleanName;
          await user.save();
          await sendWhatsAppMessage(userId, `Got it, ${cleanName}!\n\nWhat's your location? (e.g., "Istanbul", "New York")\n\nThis helps me set accurate reminder times.`);
        }
        return;
      }
      
      if (!user.location) {
        // Location setup
        const timezoneInfo = await detectLocationTimezone(messageText);
        if (timezoneInfo) {
          user.location = timezoneInfo.location;
          user.timezoneOffset = timezoneInfo.timezoneOffset;
          user.isSetup = true;
          await user.save();
          
          await sendWhatsAppMessage(userId, `${timezoneInfo.confirmation}\n\n✅ Setup complete, ${user.preferredName}!\n\n📋 How to set reminders:\n• "gym at 7pm today"\n• "call mom at 3pm tomorrow"\n• "meeting Monday at 2pm"\n\n⚠️ Always include specific day and time\n\nCommands: "list reminders", "change name to X"\n\nReady! 🎯`);
        } else {
          await sendWhatsAppMessage(userId, `Please specify your location clearly:\n\n• "Istanbul"\n• "New York"\n• "London"\n\nThis helps me set accurate times.`);
        }
        return;
      }
    }

    // Handle commands for setup users
    
    // Name change check
    const nameChange = isNameChange(messageText);
    if (nameChange) {
      user.preferredName = nameChange;
      await user.save();
      await sendWhatsAppMessage(userId, `✅ Updated! I'll call you ${nameChange}.`);
      return;
    }
    
    // List reminders
    if (messageText.toLowerCase().includes('list') || 
        messageText.toLowerCase().includes('show') || 
        messageText.toLowerCase().includes('my reminders')) {
      
      const reminders = await Reminder.find({ 
        userId: userId, 
        isCompleted: false,
        scheduledTime: { $gt: new Date() }
      }).sort({ scheduledTime: 1 });
      
      if (reminders.length > 0) {
        let response = `📋 Your reminders, ${user.preferredName}:\n\n`;
        reminders.forEach((reminder, index) => {
          response += `${index + 1}. ${reminder.message}\n   📅 ${reminder.userLocalTime}\n\n`;
        });
        await sendWhatsAppMessage(userId, response);
      } else {
        await sendWhatsAppMessage(userId, `📋 No reminders set, ${user.preferredName}.\n\nTry: "gym at 7pm"`);
      }
      return;
    }
    
    // Reminder analysis
    const analysis = await analyzeReminder(messageText, user.preferredName);
    
    if (analysis && analysis.isReminder) {
      if (analysis.timeFound && !analysis.needsTime) {
        // Complete reminder with time
        const reminderData = parseReminderWithTimezone(messageText, analysis.task, user.timezoneOffset);
        
        if (reminderData && reminderData.scheduledTime > new Date()) {
          const reminder = new Reminder({
            userId: userId,
            userName: userName,
            message: reminderData.message,
            scheduledTime: reminderData.scheduledTime,
            userLocalTime: reminderData.userLocalTime
          });
          
          await reminder.save();
          
          await sendWhatsAppMessage(userId, `✅ ${analysis.motivation}\n\nReminder: "${reminderData.message}"\n📅 ${reminderData.userLocalTime}\n\nConfirmed, ${user.preferredName}! 🎯`);
        } else {
          await sendWhatsAppMessage(userId, `⚠️ That time has passed, ${user.preferredName}.\n\nTry: "${analysis.task} tomorrow at 9am"`);
        }
      } else {
        // Needs time confirmation
        await sendWhatsAppMessage(userId, `📝 Task: "${analysis.task}"\n\n⚠️ Please specify exact day and time:\n\n• "at 7pm today"\n• "at 3pm tomorrow"\n• "Monday at 2pm"\n\nBe specific to avoid confusion.`);
      }
      return;
    }
    
    // General help
    const remainingMsgs = usageCheck.remainingMessages;
    let warningText = remainingMsgs <= 10 ? `\n\n⚠️ ${remainingMsgs} messages left today` : '';
    
    await sendWhatsAppMessage(userId, `Hi ${user.preferredName}! 🤖\n\n📋 Set reminders with specific times:\n\n• "gym at 7pm today"\n• "call mom at 3pm tomorrow"\n• "meeting Monday at 2pm"\n\n⚠️ Always include day and exact time\n\nCommands: "list reminders"${warningText}`);
    
  } catch (error) {
    console.error('❌ Handler error:', error);
    try {
      await sendWhatsAppMessage(message.from, '❌ Something went wrong. Please try again.');
    } catch (sendError) {
      console.error('❌ Send error:', sendError);
    }
  }
}

// Cron job for reminders
cron.schedule('* * * * *', async () => {
  try {
    const now = new Date();
    const dueReminders = await Reminder.find({
      scheduledTime: { $lte: now },
      isCompleted: false
    });

    console.log(`⏰ Checking reminders: ${dueReminders.length} due`);

    for (const reminder of dueReminders) {
      try {
        const user = await User.findOne({ userId: reminder.userId });
        const preferredName = user?.preferredName || 'there';
        
        await sendWhatsAppMessage(
          reminder.userId,
          `🔔 REMINDER\n\n"${reminder.message}"\n\nTime to act, ${preferredName}! 💪`
        );
        
        reminder.isCompleted = true;
        await reminder.save();
        
        console.log(`✅ Reminded ${preferredName}: ${reminder.message}`);
      } catch (error) {
        console.error(`❌ Reminder error:`, error);
      }
    }
  } catch (error) {
    console.error('❌ Cron error:', error);
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: '🤖 Jarvis - Smart Reminder Assistant',
    message: 'Direct, efficient, AI-powered reminders',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    uptime: process.uptime(),
    mongodb_status: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    twilio_status: process.env.TWILIO_ACCOUNT_SID ? 'configured' : 'not configured',
    openai_status: process.env.OPENAI_API_KEY ? 'configured' : 'not configured',
    features: [
      '🤖 AI-powered conversation understanding',
      '📍 Location-based timezone setup',
      '✅ Smart reminder confirmation',
      '💪 Contextual motivational messages',
      '📋 Reminder management',
      '🎯 Direct, efficient responses',
      '🚫 Usage limits with upgrade prompts'
    ]
  });
});

// Error handling
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log('🤖 Jarvis Smart Reminder Assistant is ready!');
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  try {
    await mongoose.connection.close();
    console.log('MongoDB connection closed');
  } catch (error) {
    console.error('Error closing MongoDB connection:', error);
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...');
  try {
    await mongoose.connection.close();
    console.log('MongoDB connection closed');
  } catch (error) {
    console.error('Error closing MongoDB connection:', error);
  }
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
  process.exit(1);
});
