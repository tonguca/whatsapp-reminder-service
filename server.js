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

// User Schema with reminder count
const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  userName: { type: String, required: true },
  preferredName: { type: String, default: null },
  location: { type: String, default: null },
  timezoneOffset: { type: Number, default: 0 },
  messageCount: { type: Number, default: 0 },
  reminderCount: { type: Number, default: 0 }, // Daily reminder count
  lastResetDate: { type: Date, default: Date.now },
  isSetup: { type: Boolean, default: false },
  pendingReminder: { type: Object, default: null },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// Reminder Schema with recurring support
const reminderSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  userName: { type: String, required: true },
  message: { type: String, required: true },
  scheduledTime: { type: Date, required: true },
  userLocalTime: { type: String, required: true },
  isCompleted: { type: Boolean, default: false },
  isRecurring: { type: Boolean, default: false },
  recurrencePattern: { type: String, default: null }, // daily, weekly, monthly
  nextOccurrence: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});

const Reminder = mongoose.model('Reminder', reminderSchema);

// Usage limits
const USAGE_LIMITS = {
  FREE_TIER_MESSAGES: 50,
  FREE_TIER_REMINDERS: 5, // Daily reminder limit
  RESET_PERIOD_HOURS: 24
};

async function checkUsageLimits(user) {
  const now = new Date();
  const timeSinceReset = now - user.lastResetDate;
  const hoursElapsed = timeSinceReset / (1000 * 60 * 60);
  
  if (hoursElapsed >= USAGE_LIMITS.RESET_PERIOD_HOURS) {
    user.messageCount = 0;
    user.reminderCount = 0; // Reset reminder count too
    user.lastResetDate = now;
    await user.save();
  }
  
  return {
    withinLimit: user.messageCount < USAGE_LIMITS.FREE_TIER_MESSAGES,
    withinReminderLimit: user.reminderCount < USAGE_LIMITS.FREE_TIER_REMINDERS,
    remainingMessages: Math.max(0, USAGE_LIMITS.FREE_TIER_MESSAGES - user.messageCount),
    remainingReminders: Math.max(0, USAGE_LIMITS.FREE_TIER_REMINDERS - user.reminderCount)
  };
}

// Calculate next occurrence for recurring reminders
function calculateNextOccurrence(currentTime, pattern) {
  const next = new Date(currentTime);
  
  switch (pattern) {
    case 'daily':
      next.setDate(next.getDate() + 1);
      break;
    case 'weekly':
      next.setDate(next.getDate() + 7);
      break;
    case 'monthly':
      next.setMonth(next.getMonth() + 1);
      break;
    default:
      return null;
  }
  
  return next;
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

// Smart reminder analyzer with typo correction
async function analyzeReminder(messageText, userName) {
  const systemMessage = `You are Jarvis, a direct and efficient reminder assistant. Analyze messages for reminder tasks and fix common typos/abbreviations.

User message: "${messageText}"

Fix common typos and understand abbreviations:
- "gum" → "gym"
- "4.30" → "4:30 PM" (assume PM for times like 4.30, 5.30, etc.)
- "630" → "6:30 AM" (assume AM for times like 630, 730, 830)
- "doc" → "doctor"
- "meds" → "medicine"
- "mom/dad" → keep as is
- partial words → best guess

Respond with JSON only:
{
  "isReminder": true/false,
  "task": "corrected task description",
  "originalTask": "original task from user",
  "timeFound": true/false,
  "timeExpression": "corrected time if found",
  "motivation": "short motivational phrase (max 4 words)",
  "needsTime": true/false,
  "isRecurring": true/false,
  "recurrencePattern": "daily/weekly/monthly" (if recurring),
  "typosCorrected": true/false,
  "clarificationNeeded": true/false
}

Examples:
- "gum at 430" → {"isReminder": true, "task": "gym", "originalTask": "gum", "timeFound": true, "timeExpression": "4:30 PM", "motivation": "Stay strong! 💪", "needsTime": false, "typosCorrected": true}
- "call mom 6" → {"isReminder": true, "task": "call mom", "timeFound": true, "timeExpression": "6:00 PM", "motivation": "Family matters! 💕", "needsTime": false, "typosCorrected": true}
- "doc appointment" → {"isReminder": true, "task": "doctor appointment", "originalTask": "doc appointment", "timeFound": false, "motivation": "Health first! 🏥", "needsTime": true, "typosCorrected": true}

If unsure about typos, set clarificationNeeded: true.`;

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

// Generate contextual motivational message for reminders
async function generateContextualMessage(task, userName) {
  const systemMessage = `You are an empathetic life coach creating a unique, personalized reminder message.

Task: "${task}"
User: ${userName}

Analyze the task context and create a completely original 2-part motivational message:
1. Present moment encouragement (why this matters now)
2. Future positive outcome (how they'll feel after)

Respond with JSON only:
{
  "encouragement": "unique motivating message for doing this task now",
  "reward": "unique positive message about the outcome/feeling after"
}

Be creative, vary your language, consider:
- Task type (health, work, personal, fitness, family, etc.)
- Time of day implications
- Emotional benefits
- Personal growth aspects
- Practical benefits
- Social connections

Make each message feel fresh, personal, and specifically crafted for this exact situation. Never repeat generic phrases.`;

  try {
    const result = await askChatGPT(task, systemMessage);
    return result || {
      encouragement: "Time to take action - you've got this!",
      reward: "You'll feel accomplished and proud after completing this!"
    };
  } catch (error) {
    console.error('Error generating contextual message:', error);
    return {
      encouragement: "Time to take action - you've got this!",
      reward: "You'll feel accomplished and proud after completing this!"
    };
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

// Enhanced reminder parsing with same-day assumption
function parseReminderWithTimezone(messageText, task, timezoneOffset = 0) {
  try {
    let parsed = chrono.parseDate(messageText);
    
    // Smart defaults for time-only messages
    if (!parsed) {
      // Check for time patterns like "at 8am", "at 3pm"
      const timeMatch = messageText.match(/at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i);
      if (timeMatch) {
        const timeStr = timeMatch[1];
        const today = new Date();
        const timeToday = chrono.parseDate(`today at ${timeStr}`);
        
        if (timeToday && timeToday > new Date()) {
          parsed = timeToday; // Same day
        } else {
          // Time has passed today, set for tomorrow
          parsed = chrono.parseDate(`tomorrow at ${timeStr}`);
        }
      }
    }
    
    // Handle common phrases
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

// Webhook for receiving messages with better error handling
app.post('/webhook', async (req, res) => {
  // Send immediate response to Twilio to prevent timeouts
  res.sendStatus(200);
  
  try {
    const body = req.body;
    console.log('📨 Webhook received:', body.From, body.Body);

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
      
      // Handle message asynchronously to prevent webhook timeouts
      setImmediate(() => {
        handleIncomingMessage(message, contact).catch(error => {
          console.error('❌ Async message handling error:', error);
        });
      });
    }
  } catch (error) {
    console.error('❌ Webhook processing error:', error);
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
    
    // Handle pending reminder confirmations
    if (user.pendingReminder && (messageText.toLowerCase() === 'yes' || messageText.toLowerCase() === 'y')) {
      // Check reminder limit before confirming
      const usageCheck = await checkUsageLimits(user);
      if (!usageCheck.withinReminderLimit) {
        user.pendingReminder = null;
        await user.save();
        
        await sendWhatsAppMessage(userId, `💙 Hey ${user.preferredName}, you've reached your daily limit of ${USAGE_LIMITS.FREE_TIER_REMINDERS} reminders!\n\nI love helping you stay organized! 😊\n\n✨ **Upgrade to unlimited** and I can help you remember everything that matters!\n\n🎯 More reminders = Better life organization\n💝 Just thinking of your success!`);
        return;
      }
      
      const pendingData = user.pendingReminder;
      
      const reminder = new Reminder({
        userId: userId,
        userName: userName,
        message: pendingData.message,
        scheduledTime: pendingData.scheduledTime,
        userLocalTime: pendingData.userLocalTime,
        isRecurring: pendingData.isRecurring || false,
        recurrencePattern: pendingData.recurrencePattern || null,
        nextOccurrence: pendingData.isRecurring ? calculateNextOccurrence(pendingData.scheduledTime, pendingData.recurrencePattern) : null
      });
      
      await reminder.save();
      
      // Increment reminder count
      user.reminderCount += 1;
      user.pendingReminder = null;
      await user.save();
      
      const recurringText = pendingData.isRecurring ? ` (${pendingData.recurrencePattern})` : '';
      const remainingReminders = USAGE_LIMITS.FREE_TIER_REMINDERS - user.reminderCount;
      const limitWarning = remainingReminders <= 2 ? `\n\n💫 ${remainingReminders} reminders left today` : '';
      
      await sendWhatsAppMessage(userId, `✅ ${pendingData.isRecurring ? 'Recurring reminder' : 'Reminder'} confirmed!\n\n"${pendingData.message}"${recurringText}\n📅 ${pendingData.userLocalTime}\n\nAll set, ${user.preferredName}! 🎯${limitWarning}`);
      return;
    }
    
    if (user.pendingReminder && (messageText.toLowerCase() === 'no' || messageText.toLowerCase() === 'n')) {
      user.pendingReminder = null;
      await user.save();
      
      await sendWhatsAppMessage(userId, `❌ Reminder cancelled, ${user.preferredName}.\n\nTry again when ready! 🎯`);
      return;
    }
    
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
          const recurringText = reminder.isRecurring ? ` (${reminder.recurrencePattern})` : '';
          response += `${index + 1}. ${reminder.message}${recurringText}\n   📅 ${reminder.userLocalTime}\n\n`;
        });
        await sendWhatsAppMessage(userId, response);
      } else {
        await sendWhatsAppMessage(userId, `📋 No reminders set, ${user.preferredName}.\n\nTry: "gym at 7pm today"`);
      }
      return;
    }
    
    // Reminder analysis
    const analysis = await analyzeReminder(messageText, user.preferredName);
    
    if (analysis && analysis.isReminder) {
      // Handle recurring reminders
      if (analysis.isRecurring) {
        if (analysis.timeFound) {
          const reminderData = parseReminderWithTimezone(messageText, analysis.task, user.timezoneOffset);
          
          if (reminderData && reminderData.scheduledTime > new Date()) {
            const dayName = new Date(reminderData.scheduledTime.getTime() + (user.timezoneOffset * 60 * 60 * 1000)).toLocaleDateString('en-US', { weekday: 'long' });
            
            await sendWhatsAppMessage(userId, `🔄 Recurring reminder:\n\n"${analysis.task}" - ${analysis.recurrencePattern}\n📅 Starting: ${dayName}, ${reminderData.userLocalTime}\n\nReply "yes" to confirm recurring reminder.`);
            
            user.pendingReminder = {
              message: analysis.task,
              scheduledTime: reminderData.scheduledTime,
              userLocalTime: reminderData.userLocalTime,
              isRecurring: true,
              recurrencePattern: analysis.recurrencePattern
            };
            await user.save();
          } else {
            await sendWhatsAppMessage(userId, `⚠️ That time has passed. Try: "${analysis.task} ${analysis.recurrencePattern} starting tomorrow at 9am"`);
          }
        } else {
          await sendWhatsAppMessage(userId, `🔄 Recurring task: "${analysis.task}" - ${analysis.recurrencePattern}\n\nWhat time should this repeat?\n\n• "at 8am daily"\n• "Mondays at 2pm"\n• "every Sunday at 10am"`);
        }
        return;
      }
      
      if (analysis.timeFound && !analysis.needsTime) {
        // Show typo corrections if any
        let confirmationMsg = `📝 Confirm reminder:\n\n"${reminderData.message}"`;
        if (analysis.typosCorrected && analysis.originalTask) {
          confirmationMsg = `📝 Confirm reminder (I corrected "${analysis.originalTask}" → "${analysis.task}"):\n\n"${reminderData.message}"`;
        }
        
        // Complete reminder with time - ask for confirmation first
        const reminderData = parseReminderWithTimezone(messageText, analysis.task, user.timezoneOffset);
        
        if (reminderData && reminderData.scheduledTime > new Date()) {
          // Show confirmation before saving
          const dayName = new Date(reminderData.scheduledTime.getTime() + (user.timezoneOffset * 60 * 60 * 1000)).toLocaleDateString('en-US', { weekday: 'long' });
          
          await sendWhatsAppMessage(userId, `${confirmationMsg}\n📅 ${dayName}, ${reminderData.userLocalTime}\n\nReply "yes" to confirm or "no" to cancel.`);
          
          // Store pending reminder in user object (temporary)
          user.pendingReminder = {
            message: reminderData.message,
            scheduledTime: reminderData.scheduledTime,
            userLocalTime: reminderData.userLocalTime
          };
          await user.save();
        } else {
          await sendWhatsAppMessage(userId, `⚠️ That time has passed, ${user.preferredName}.\n\nTry: "${analysis.task} tomorrow at 9am"`);
        }
      } else if (analysis.clarificationNeeded) {
        // AI needs clarification
        await sendWhatsAppMessage(userId, `🤔 I think you mean "${analysis.task}" but I'm not sure.\n\nDid you mean:\n• "${analysis.task} at [time]"?\n\nPlease clarify with specific day and time.`);
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

// Cron job for reminders with recurring support
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
        
        // Generate contextual motivational message
        const contextualMsg = await generateContextualMessage(reminder.message, preferredName);
        
        const recurringIcon = reminder.isRecurring ? '🔄' : '🔔';
        await sendWhatsAppMessage(
          reminder.userId,
          `${recurringIcon} REMINDER: "${reminder.message}"\n\n💪 ${contextualMsg.encouragement}\n\n🌟 ${contextualMsg.reward}\n\nGo for it, ${preferredName}!`
        );
        
        // Handle recurring reminders
        if (reminder.isRecurring && reminder.nextOccurrence) {
          reminder.scheduledTime = reminder.nextOccurrence;
          reminder.nextOccurrence = calculateNextOccurrence(reminder.nextOccurrence, reminder.recurrencePattern);
          reminder.userLocalTime = new Date(reminder.scheduledTime.getTime() + (user.timezoneOffset * 60 * 60 * 1000)).toLocaleString();
          await reminder.save();
          
          console.log(`🔄 Recurring reminder rescheduled: ${reminder.message} for ${reminder.userLocalTime}`);
        } else {
          reminder.isCompleted = true;
          await reminder.save();
        }
        
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
    message: 'Direct, efficient, AI-powered reminders with contextual motivation',
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
      '🔄 Recurring reminders (daily/weekly/monthly)',
      '💪 Contextual AI motivational messages',
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
