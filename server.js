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

// Add request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Environment variables validation - UPDATED FOR CHATGPT
const requiredEnvVars = {
  VERIFY_TOKEN: process.env.VERIFY_TOKEN,
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER: process.env.TWILIO_PHONE_NUMBER,
  MONGODB_URI: process.env.MONGODB_URI,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY
};

// Check for missing environment variables
const missingVars = Object.entries(requiredEnvVars)
  .filter(([key, value]) => !value)
  .map(([key]) => key);

if (missingVars.length > 0) {
  console.error('Missing required environment variables:', missingVars);
  console.error('Please set these variables in your Render dashboard');
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
        if (process.env.NODE_ENV !== 'production') {
          process.exit(1);
        }
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
  timezone: { type: String, default: null },
  timezoneOffset: { type: Number, default: null },
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

// ChatGPT function
async function askChatGPT(prompt, systemMessage = '') {
  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: systemMessage || 'You are a helpful assistant for a WhatsApp reminder bot.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 300,
        temperature: 0.7
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    
    return response.data.choices[0].message.content.trim();
  } catch (error) {
    console.error('Error with ChatGPT:', error.response?.data || error.message);
    return null;
  }
}

// Smart reminder detection
async function detectReminderIntent(messageText) {
  const systemMessage = `Analyze if this message is a reminder request. Look for time references (at 3pm, tomorrow, friday, tonight, etc.) AND actions/tasks.

Respond with JSON only:
{
  "isReminder": true/false,
  "task": "extracted task" (if reminder),
  "motivationalMessage": "encouraging message" (if reminder),
  "response": "helpful response" (if not reminder)
}`;

  try {
    const result = await askChatGPT(messageText, systemMessage);
    return JSON.parse(result);
  } catch (error) {
    console.error('Error parsing ChatGPT response:', error);
    return { 
      isReminder: false, 
      response: "I help you set reminders! Try saying 'call mom at 6pm' or 'meeting tomorrow at 2pm'" 
    };
  }
}

// Timezone detection
async function detectTimezone(userInput) {
  const systemMessage = `User is telling you their current time or location. Calculate their timezone offset from UTC.

Respond with JSON only:
{
  "timezoneOffset": number (hours from UTC),
  "timezone": "readable name",
  "confirmation": "friendly confirmation message"
}`;

  try {
    const result = await askChatGPT(userInput, systemMessage);
    return JSON.parse(result);
  } catch (error) {
    console.error('Error detecting timezone:', error);
    return null;
  }
}

// Twilio WhatsApp function
async function sendWhatsAppMessage(to, message) {
  try {
    console.log(`Sending message to ${to}: ${message.substring(0, 50)}...`);
    
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
    console.log('Message sent successfully:', response.data?.sid || 'Unknown ID');
    return response.data;
  } catch (error) {
    console.error('Error sending WhatsApp message:', {
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      message: error.message
    });
    throw error;
  }
}

// Context detection
function detectContext(messageText) {
  const text = messageText.toLowerCase();
  
  const contexts = {
    family: {
      keywords: ['call mom', 'call dad', 'family', 'mother', 'father', 'sister', 'brother', 'mom', 'dad'],
      emoji: '💕',
      encouragement: 'Family time is precious! 💕',
      reminder: '👨‍👩‍👧‍👦 Time to connect with your loved ones!'
    },
    meeting: {
      keywords: ['meeting', 'conference', 'zoom', 'teams', 'call', 'appointment'],
      emoji: '🤝',
      encouragement: 'You\'ve got this! 🤝',
      reminder: '💼 Time for your meeting!'
    },
    health: {
      keywords: ['doctor', 'dentist', 'clinic', 'hospital', 'medicine', 'medication'],
      emoji: '🏥',
      encouragement: 'Health is wealth! 🏥',
      reminder: '⚕️ Time for your health!'
    },
    workout: {
      keywords: ['gym', 'workout', 'exercise', 'run', 'fitness', 'yoga'],
      emoji: '💪',
      encouragement: 'You\'re stronger than you think! 💪',
      reminder: '🔥 Time to get moving!'
    },
    work: {
      keywords: ['deadline', 'project', 'task', 'work', 'email', 'report'],
      emoji: '⚡',
      encouragement: 'You\'re capable of amazing things! ⚡',
      reminder: '🎯 Time to get things done!'
    }
  };
  
  for (const [contextName, contextData] of Object.entries(contexts)) {
    if (contextData.keywords.some(keyword => text.includes(keyword))) {
      return contextData;
    }
  }
  
  return {
    emoji: '⭐',
    encouragement: 'I\'ll help you remember! ⭐',
    reminder: '🔔 Here\'s your reminder!'
  };
}

// Enhanced reminder parsing
async function parseReminderWithTimezone(messageText, user) {
  try {
    const parsed = chrono.parseDate(messageText);
    if (!parsed) return null;
    
    // Convert to UTC for storage
    const utcTime = new Date(parsed.getTime() - (user.timezoneOffset * 60 * 60 * 1000));
    
    // Extract task
    const timeMatch = messageText.match(/\s+(at|on|in|tomorrow|today|next|tonight)\s+/i);
    let reminderText = messageText;
    
    if (timeMatch) {
      reminderText = messageText.substring(0, timeMatch.index).trim();
    }
    
    reminderText = reminderText.replace(/^(remind me to|reminder to|remind)\s+/i, '');
    
    const context = detectContext(messageText);
    
    return {
      message: reminderText || 'Reminder',
      scheduledTime: utcTime,
      userLocalTime: parsed.toLocaleString(),
      context: context
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

  console.log('Webhook verification attempt:', { mode, token: token ? 'provided' : 'missing' });

  if (mode && token) {
    if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
      console.log('Webhook verified successfully');
      res.status(200).send(challenge);
    } else {
      console.error('Webhook verification failed - token mismatch');
      res.sendStatus(403);
    }
  } else {
    console.error('Webhook verification failed - missing parameters');
    res.sendStatus(400);
  }
});

// Webhook for receiving messages
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    console.log('Received Twilio webhook:', JSON.stringify(body, null, 2));

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

// Enhanced message handling
async function handleIncomingMessage(message, contact) {
  try {
    const userId = message.from;
    const userName = contact?.profile?.name || 'User';
    const messageText = message.text.body;

    console.log(`Processing message from ${userName} (${userId}): ${messageText}`);

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

    // Timezone setup for new users
    if (!user.isSetup) {
      await sendWhatsAppMessage(userId, `👋 Welcome ${userName}! I'm your smart reminder assistant! 🤖\n\n⏰ To set accurate reminders, what time is it where you are right now?\n\nExample: "It's 3:30 PM" or "Istanbul"`);
      
      const timezoneInfo = await detectTimezone(messageText);
      if (timezoneInfo) {
        user.timezoneOffset = timezoneInfo.timezoneOffset;
        user.timezone = timezoneInfo.timezone;
        user.isSetup = true;
        await user.save();
        
        await sendWhatsAppMessage(userId, `✅ ${timezoneInfo.confirmation}\n\n🎉 Now you can say:\n• "Call mom at 6pm"\n• "Meeting tomorrow at 2pm"\n• "Gym tonight"\n\nNo need to say "remind me"! 💝`);
      }
      return;
    }

    // List reminders
    if (messageText.toLowerCase().includes('list') || messageText.toLowerCase().includes('my reminders')) {
      const reminders = await Reminder.find({ 
        userId: userId, 
        isCompleted: false,
        scheduledTime: { $gt: new Date() }
      }).sort({ scheduledTime: 1 });
      
      if (reminders.length > 0) {
        let response = '📋 Your upcoming reminders:\n\n';
        reminders.forEach((reminder, index) => {
          const context = detectContext(reminder.message);
          response += `${index + 1}. ${reminder.message} ${context.emoji}\n   📅 ${reminder.userLocalTime}\n\n`;
        });
        await sendWhatsAppMessage(userId, response);
      } else {
        await sendWhatsAppMessage(userId, '📋 No upcoming reminders.\n\n💡 Try: "Call mom at 6pm" or "Meeting tomorrow 2pm"');
      }
      return;
    }

    // Use ChatGPT for intent detection
    const chatGPTResponse = await detectReminderIntent(messageText);
    
    if (chatGPTResponse.isReminder) {
      const reminderData = await parseReminderWithTimezone(messageText, user);
      
      if (reminderData && reminderData.scheduledTime > new Date()) {
        const reminder = new Reminder({
          userId: userId,
          userName: userName,
          message: reminderData.message,
          scheduledTime: reminderData.scheduledTime,
          userLocalTime: reminderData.userLocalTime
        });
        
        await reminder.save();
        
        const context = reminderData.context;
        const confirmationMessage = `✅ ${chatGPTResponse.motivationalMessage || context.encouragement}\n\n⏰ Reminder set for ${reminderData.userLocalTime}:\n"${reminderData.message}" ${context.emoji}`;
        await sendWhatsAppMessage(userId, confirmationMessage);
      } else {
        await sendWhatsAppMessage(userId, `❌ I couldn't understand the time.\n\n💡 Try: "Call John at 3 PM" or "Meeting tomorrow at 10 AM"`);
      }
    } else {
      const responseMessage = chatGPTResponse.response || 
        `Hello ${userName}! 👋 I'm your smart reminder assistant!\n\n💝 Just tell me what and when:\n• "Call mom at 6 PM"\n• "Meeting tomorrow at 2 PM"\n• "Gym tonight"\n\nTry "list my reminders" to see what's coming up!`;
      
      await sendWhatsAppMessage(userId, responseMessage);
    }
  } catch (error) {
    console.error('Error handling message:', error);
    try {
      await sendWhatsAppMessage(message.from, '❌ Sorry, something went wrong. Please try again!');
    } catch (sendError) {
      console.error('Error sending error message:', sendError);
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

    console.log(`Checking reminders at ${now.toISOString()}: ${dueReminders.length} due reminders found`);

    for (const reminder of dueReminders) {
      try {
        const context = detectContext(reminder.message);
        await sendWhatsAppMessage(
          reminder.userId,
          `${context.reminder}\n\n"${reminder.message}"\n\n💝 From your AI assistant`
        );
        
        reminder.isCompleted = true;
        await reminder.save();
        
        console.log(`Reminder sent to ${reminder.userName}: ${reminder.message}`);
      } catch (error) {
        console.error(`Error sending reminder to ${reminder.userName}:`, error);
      }
    }
  } catch (error) {
    console.error('Error checking reminders:', error);
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: '🤖 Smart WhatsApp Reminder Assistant with ChatGPT!',
    message: 'Ready to understand natural language and help you remember',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    uptime: process.uptime(),
    mongodb_status: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    twilio_status: process.env.TWILIO_ACCOUNT_SID ? 'configured' : 'not configured',
    openai_status: process.env.OPENAI_API_KEY ? 'configured' : 'not configured',
    features: [
      '🤖 ChatGPT natural language understanding',
      '🌍 Smart timezone detection',
      '💕 Emotional intelligence',
      '📋 Easy reminder management'
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
  console.log('🤖 Smart WhatsApp Assistant with ChatGPT is ready!');
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
