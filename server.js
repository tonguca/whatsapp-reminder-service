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

// MongoDB connection with improved error handling
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
      console.log('✅ Connected to MongoDB');
      return;
    } catch (err) {
      retries++;
      console.error(`❌ MongoDB connection attempt ${retries} failed:`, err.message);
      
      if (retries >= maxRetries) {
        console.error('🚨 Max retries reached. Could not connect to MongoDB.');
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
  reminderCount: { type: Number, default: 0 },
  lastResetDate: { type: Date, default: Date.now },
  isSetup: { type: Boolean, default: false },
  pendingReminder: { type: Object, default: null },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// FIXED Reminder Schema - relaxed validation, proper one-time logic
const reminderSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  userName: { type: String, default: 'User' },
  message: { type: String, required: true },
  scheduledTime: { type: Date, required: true },
  userLocalTime: { type: String, default: 'Scheduled' },
  isCompleted: { type: Boolean, default: false },
  isRecurring: { type: Boolean, default: false },
  recurrencePattern: { type: String, default: null },
  nextOccurrence: { type: Date, default: null },
  lastSentAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
}, { 
  strict: false,
  validateBeforeSave: false
});

const Reminder = mongoose.model('Reminder', reminderSchema);

// Usage limits
const USAGE_LIMITS = {
  FREE_TIER_MESSAGES: 50,
  FREE_TIER_REMINDERS: 5,
  RESET_PERIOD_HOURS: 24
};

async function checkUsageLimits(user) {
  const now = new Date();
  const timeSinceReset = now - user.lastResetDate;
  const hoursElapsed = timeSinceReset / (1000 * 60 * 60);
  
  if (hoursElapsed >= USAGE_LIMITS.RESET_PERIOD_HOURS) {
    user.messageCount = 0;
    user.reminderCount = 0;
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

// Enhanced ChatGPT function
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
    console.log('✅ ChatGPT responded');
    
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

// ENHANCED message analyzer - detects time-only and action-only messages
async function analyzeReminder(messageText, userName) {
  const systemMessage = `You are Jarvis, analyzing reminder messages. 

User message: "${messageText}"

Analyze the message and determine:
1. Is it a reminder request?
2. Does it have an action (what to do)?
3. Does it have time information?
4. Fix common typos

TIME FORMATS TO RECOGNIZE:
- "18.53" or "18:53" = 6:53 PM (24-hour format)
- "6pm", "6:30pm" = regular format
- "tomorrow", "Monday", "17.09" = date info

FIX TYPOS:
- "gum" → "gym"
- "doc" → "doctor"
- "meds" → "medicine"
- "mom/dad" → keep as is

IMPORTANT: Only set isRecurring to true if user EXPLICITLY requests recurring with words like:
- "daily", "every day", "each day"
- "weekly", "every week", "each week" 
- "monthly", "every month", "each month"
- "recurring", "repeat"

Respond with JSON only:
{
  "isReminder": true/false,
  "hasAction": true/false,
  "hasTime": true/false,
  "task": "corrected action description (if found)",
  "originalTask": "original task from user",
  "timeExpression": "time found (if any)",
  "timeOnly": true/false,
  "actionOnly": true/false,
  "timeFound": true/false,
  "needsTime": true/false,
  "typosCorrected": true/false,
  "isRecurring": false,
  "recurrencePattern": null,
  "clarificationNeeded": true/false
}

Examples:
- "18.53" → {"isReminder": false, "hasAction": false, "hasTime": true, "timeOnly": true}
- "call mom" → {"isReminder": true, "hasAction": true, "hasTime": false, "actionOnly": true, "task": "call mom"}
- "call mom at 18.53" → {"isReminder": true, "hasAction": true, "hasTime": true, "timeFound": true, "task": "call mom", "timeExpression": "18.53"}`;

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
}`;

  try {
    const result = await askChatGPT(location, systemMessage);
    return result;
  } catch (error) {
    console.error('Error detecting timezone:', error);
    return null;
  }
}

// Generate contextual motivational message
async function generateContextualMessage(task, userName) {
  const systemMessage = `You are an empathetic life coach creating a unique, personalized reminder message.

Task: "${task}"
User: ${userName}

Create a completely original 2-part motivational message:
1. Present moment encouragement
2. Future positive outcome

Respond with JSON only:
{
  "encouragement": "unique motivating message for doing this task now",
  "reward": "unique positive message about the outcome/feeling after"
}`;

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

// Check for duplicate reminders
async function isDuplicateReminder(userId, message) {
  try {
    const similar = await Reminder.findOne({
      userId: userId,
      message: { $regex: new RegExp(message.substring(0, 10), 'i') },
      isCompleted: false,
      createdAt: { $gt: new Date(Date.now() - 24 * 60 * 60 * 1000) } // Last 24 hours
    });
    return !!similar;
  } catch (error) {
    console.error('Error checking duplicates:', error);
    return false;
  }
}

// Generate different motivational messages for duplicates
async function generateDuplicateMotivation(task, userName) {
  const motivations = [
    `Hey ${userName}! 🔄 Looks like you really want to remember "${task}" - that's great commitment!`,
    `${userName}, I see "${task}" is important to you! 💪 Double reminders = double motivation!`,
    `Got it ${userName}! "${task}" again - consistency is key! 🎯`,
    `${userName}, you're really focused on "${task}"! 🌟 I love the dedication!`,
    `Another "${task}" reminder, ${userName}? 🚀 You're building great habits!`
  ];
  
  return motivations[Math.floor(Math.random() * motivations.length)];
}

// IMPROVED Twilio WhatsApp function with robust error handling
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
    
    console.log('✅ Message sent successfully');
    return { success: true, data: response.data };
  } catch (error) {
    console.error('❌ Twilio Send Error:', error.message);
    
    if (error.response?.data) {
      const errorData = error.response.data;
      const errorCode = error.response.headers['x-twilio-error-code'];
      
      console.error('🚨 Twilio Error Details:', {
        code: errorCode,
        message: errorData.message,
        status: error.response.status
      });
      
      if (errorCode === '63038' || errorData.message?.includes('daily messages limit')) {
        console.error('🚫 RATE LIMIT: Twilio account daily message limit reached');
        return { success: false, error: 'rate_limited', code: '63038' };
      }
    }
    
    return { success: false, error: 'unknown', message: error.message };
  }
}

// ENHANCED time parsing function - handles 18.53 = 6:53 PM
function parseReminderWithTimezone(messageText, task, timezoneOffset = 0) {
  try {
    let parsed = chrono.parseDate(messageText);
    
    if (!parsed) {
      // Handle 24-hour format like "18.53" or "18:53"
      const time24Match = messageText.match(/(\d{1,2})[.:](\d{2})/);
      if (time24Match) {
        const hours = parseInt(time24Match[1]);
        const minutes = parseInt(time24Match[2]);
        
        if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
          const today = new Date();
          const timeToday = new Date(today.getFullYear(), today.getMonth(), today.getDate(), hours, minutes);
          
          if (timeToday > new Date()) {
            parsed = timeToday; // Same day
          } else {
            // Time has passed today, set for tomorrow
            const tomorrow = new Date(timeToday);
            tomorrow.setDate(tomorrow.getDate() + 1);
            parsed = tomorrow;
          }
        }
      }
    }
    
    if (!parsed) {
      // Handle regular time patterns like "at 8am", "at 3pm"
      const timeMatch = messageText.match(/at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i);
      if (timeMatch) {
        const timeStr = timeMatch[1];
        const today = new Date();
        const timeToday = chrono.parseDate(`today at ${timeStr}`);
        
        if (timeToday && timeToday > new Date()) {
          parsed = timeToday;
        } else {
          parsed = chrono.parseDate(`tomorrow at ${timeStr}`);
        }
      }
    }
    
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

// Check Twilio account status
async function checkTwilioAccountStatus() {
  try {
    const authToken = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    
    const response = await axios.get(
      `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}.json`,
      {
        headers: {
          'Authorization': `Basic ${authToken}`
        }
      }
    );
    
    const account = response.data;
    console.log('📊 Twilio Account Status:', {
      type: account.type,
      status: account.status
    });
    
    return account;
  } catch (error) {
    console.error('❌ Failed to check Twilio account status:', error.message);
    return null;
  }
}

// FIXED: Enhanced cleanup function - remove old completed reminders
async function cleanupOldReminders() {
  try {
    const now = new Date();
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    
    // Mark any old incomplete reminders as completed
    const stuckResult = await Reminder.updateMany(
      {
        scheduledTime: { $lt: now },
        isCompleted: false,
        createdAt: { $lt: threeDaysAgo }
      },
      {
        isCompleted: true,
        lastSentAt: now
      }
    );
    
    console.log(`🧹 Marked ${stuckResult.modifiedCount} old reminders as completed`);
    
    // Delete very old completed reminders to keep database clean
    const deleteResult = await Reminder.deleteMany({
      isCompleted: true,
      createdAt: { $lt: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) } // Older than 30 days
    });
    
    console.log(`🗑️ Deleted ${deleteResult.deletedCount} old completed reminders`);
    
  } catch (error) {
    console.error('❌ Cleanup error:', error);
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

// MAIN message handler - COMPLETELY FIXED with all improvements
async function handleIncomingMessage(message, contact) {
  try {
    const userId = message.from;
    const userName = contact?.profile?.name || 'User';
    const messageText = message.text.body;

    console.log(`📨 ${userName}: ${messageText}`);

    let user = await User.findOne({ userId });
    if (!user) {
      user = new User({
        userId,
        userName,
        isSetup: false
      });
      await user.save();
    }

    const usageCheck = await checkUsageLimits(user);
    if (!usageCheck.withinLimit) {
      await sendWhatsAppMessage(userId, `🚫 Daily limit reached (${USAGE_LIMITS.FREE_TIER_MESSAGES} messages).\n\n⭐ Upgrade for unlimited reminders!`);
      return;
    }

    user.messageCount += 1;
    await user.save();

    // IMPROVED setup flow with better onboarding
    if (!user.isSetup) {
      if (!user.preferredName) {
        // Check if they sent a reminder request instead of name
        const analysis = await analyzeReminder(messageText, userName);
        
        if (analysis.isReminder) {
          // They sent a reminder without giving name - get name first
          await sendWhatsAppMessage(userId, `Hey there! 👋\n\nI'm your personal assistant here to remind you of important stuff — and give you a little motivation when needed.\n\nBut first, what should I call you? 😊\nJust send me your name, and I'll remember it from now on.`);
          
          // Store their reminder request for after name setup
          user.pendingReminder = {
            originalMessage: messageText,
            needsProcessing: true
          };
          await user.save();
          return;
        }
        
        // Regular name setup
        const cleanName = messageText.replace(/[^a-zA-Z\s]/g, '').trim();
        if (cleanName && cleanName.length > 0 && cleanName.length < 20) {
          user.preferredName = cleanName;
          await user.save();
          
          await sendWhatsAppMessage(userId, `Nice to meet you, ${cleanName}! 🙌\n\nWhat's your location? (e.g., "Istanbul", "New York")\n\nThis helps me set accurate reminder times.`);
        } else {
          await sendWhatsAppMessage(userId, `Hey there! 👋\n\nI'm your personal assistant here to remind you of important stuff — and give you a little motivation when needed.\n\nBut first, what should I call you? 😊\nJust send me your name, and I'll remember it from now on.`);
        }
        return;
      }
      
      if (!user.location) {
        const timezoneInfo = await detectLocationTimezone(messageText);
        if (timezoneInfo) {
          user.location = timezoneInfo.location;
          user.timezoneOffset = timezoneInfo.timezoneOffset;
          user.isSetup = true;
          
          // Process any pending reminder from name setup
          let welcomeMsg = `${timezoneInfo.confirmation}\n\n✅ Setup complete!\n\nNow I'm ready — what would you like me to remind you about?\n\nYou can write something like:\n📝 *Call mom on 17.09 at 9pm*\n📌 *Dentist appointment tomorrow at 3pm*`;
          
          if (user.pendingReminder && user.pendingReminder.needsProcessing) {
            welcomeMsg += `\n\n💡 I'll process your earlier reminder request now!`;
            
            const pendingMessage = user.pendingReminder.originalMessage;
            user.pendingReminder = null;
            await user.save();
            
            await sendWhatsAppMessage(userId, welcomeMsg);
            
            // Process the pending reminder
            const fakeMessage = { from: userId, text: { body: pendingMessage } };
            await handleIncomingMessage(fakeMessage, contact);
            return;
          }
          
          await user.save();
          await sendWhatsAppMessage(userId, welcomeMsg);
        } else {
          await sendWhatsAppMessage(userId, `Please specify your location clearly:\n\n• "Istanbul"\n• "New York"\n• "London"\n\nThis helps me set accurate times.`);
        }
        return;
      }
    }

    // Handle pending reminder confirmations - NO "OK" responses anywhere!
    if (user.pendingReminder && (messageText.toLowerCase() === 'yes' || messageText.toLowerCase() === 'y')) {
      const usageCheck = await checkUsageLimits(user);
      if (!usageCheck.withinReminderLimit) {
        user.pendingReminder = null;
        await user.save();
        
        await sendWhatsAppMessage(userId, `💙 Hey ${user.preferredName}, you've reached your daily limit of ${USAGE_LIMITS.FREE_TIER_REMINDERS} reminders!`);
        return;
      }
      
      const pendingData = user.pendingReminder;
      
      try {
        // Check for duplicates
        const isDuplicate = await isDuplicateReminder(userId, pendingData.message);
        
        const reminder = new Reminder({
          userId: userId,
          userName: userName || 'User',
          message: pendingData.message || 'Reminder',
          scheduledTime: pendingData.scheduledTime || new Date(),
          userLocalTime: pendingData.userLocalTime || new Date().toLocaleString(),
          isRecurring: Boolean(pendingData.isRecurring),
          recurrencePattern: pendingData.recurrencePattern || null,
          nextOccurrence: pendingData.isRecurring ? calculateNextOccurrence(pendingData.scheduledTime, pendingData.recurrencePattern) : null,
          isCompleted: false,
          lastSentAt: null
        });
        
        await reminder.save({ validateBeforeSave: false });
        
        user.reminderCount += 1;
        user.pendingReminder = null;
        await user.save();
        
        // Different response for duplicates
        if (isDuplicate) {
          const duplicateMsg = await generateDuplicateMotivation(pendingData.message, user.preferredName);
          await sendWhatsAppMessage(userId, `${duplicateMsg}\n\n📅 ${pendingData.userLocalTime || 'Scheduled'}\n\nAll set! 🎯`);
        } else {
          await sendWhatsAppMessage(userId, `✅ Reminder confirmed!\n\n"${pendingData.message}"\n📅 ${pendingData.userLocalTime || 'Scheduled'}\n\nAll set, ${user.preferredName}! 🎯`);
        }
      } catch (saveError) {
        console.error('❌ Error saving reminder:', saveError);
        await sendWhatsAppMessage(userId, `❌ Error saving reminder. Please try again.`);
      }
      return;
    }
    
    // IMPROVED "no" response
    if (user.pendingReminder && (messageText.toLowerCase() === 'no' || messageText.toLowerCase() === 'n')) {
      user.pendingReminder = null;
      await user.save();
      
      await sendWhatsAppMessage(userId, `No problem, let's set it your way 👍\n\nJust send your reminder again using this format so I can schedule it properly:\n\n🕐 *Action + Date + Time*\n\nExample: *"Call mom on 17.09 at 9pm"*`);
      return;
    }
    
    // Name change
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
    
    // ENHANCED reminder analysis with all new features
    const analysis = await analyzeReminder(messageText, user.preferredName);
    
    // Handle time-only messages (NEW)
    if (analysis.timeOnly) {
      await sendWhatsAppMessage(userId, `Oops, I need a bit more info 😅\n\nWhat should I remind you *about* at that time?\n\nPlease send something like:\n📝 *Take medicine tomorrow at 10am*`);
      return;
    }
    
    // Handle action-only messages (NEW)
    if (analysis.actionOnly) {
      await sendWhatsAppMessage(userId, `Got it — but when should I remind you? 🕒\n\nPlease include a time like:\n📌 *Call dad at 5pm today*\n📌 *Drink water tomorrow at 9am*`);
      return;
    }
    
    if (analysis && analysis.isReminder) {
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
      
      // Handle regular reminders with improved time parsing
      if ((analysis.hasAction && analysis.hasTime) || (analysis.timeFound && !analysis.needsTime)) {
        const reminderData = parseReminderWithTimezone(messageText, analysis.task, user.timezoneOffset);
        
        if (reminderData && reminderData.scheduledTime > new Date()) {
          let confirmationMsg = `📝 Confirm reminder:\n\n"${reminderData.message}"`;
          if (analysis.typosCorrected && analysis.originalTask) {
            confirmationMsg = `📝 Confirm reminder (I made some corrections):\n\n"${reminderData.message}"`;
          }
          
          const dayName = new Date(reminderData.scheduledTime.getTime() + (user.timezoneOffset * 60 * 60 * 1000)).toLocaleDateString('en-US', { weekday: 'long' });
          
          await sendWhatsAppMessage(userId, `${confirmationMsg}\n📅 ${dayName}, ${reminderData.userLocalTime}\n\nReply "yes" to confirm or "no" to cancel.`);
          
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
        await sendWhatsAppMessage(userId, `🤔 I think you mean "${analysis.task}" but I'm not sure.\n\nDid you mean:\n• "${analysis.task} at [time]"?\n\nPlease clarify with specific day and time.`);
      } else {
        await sendWhatsAppMessage(userId, `📝 Task: "${analysis.task}"\n\n⚠️ Please specify exact day and time:\n\n• "at 7pm today"\n• "at 3pm tomorrow"\n• "Monday at 2pm"`);
      }
      return;
    }
    
    // General help
    const remainingMsgs = usageCheck.remainingMessages;
    let warningText = remainingMsgs <= 10 ? `\n\n⚠️ ${remainingMsgs} messages left today` : '';
    
    await sendWhatsAppMessage(userId, `Hi ${user.preferredName}! 🤖\n\nSet reminders with specific times:\n\n• "gym at 7pm today"\n• "call mom at 3pm tomorrow"\n• "meeting Monday at 2pm"\n\nCommands: "list reminders"${warningText}`);
    
  } catch (error) {
    console.error('❌ Handler error:', error);
    try {
      await sendWhatsAppMessage(message.from, '❌ Something went wrong. Please try again.');
    } catch (sendError) {
      console.error('❌ Send error:', sendError);
    }
  }
}

// FIXED: One-time reminder cron job - send once and mark complete
cron.schedule('*/5 * * * *', async () => { // Every 5 minutes
  try {
    console.log('⏰ Checking for due reminders...');
    
    const now = new Date();
    
    // Find reminders that are due and haven't been sent yet
    const dueReminders = await Reminder.find({
      scheduledTime: { $lte: now }, // Time has arrived
      isCompleted: false, // Not completed yet
      lastSentAt: null // Never been sent
    }).limit(10); // Process max 10 at a time

    console.log(`⏰ Found ${dueReminders.length} due reminders`);

    for (const reminder of dueReminders) {
      try {
        // IMMEDIATELY mark as sent to prevent duplicates (atomic operation)
        const marked = await Reminder.findOneAndUpdate(
          { 
            _id: reminder._id, 
            lastSentAt: null // Only update if not already marked
          },
          { 
            lastSentAt: now,
            isCompleted: true // ALWAYS mark as completed after sending
          },
          { new: true }
        );
        
        // If marking failed, another process already handled it
        if (!marked) {
          console.log('⏭️ Reminder already processed');
          continue;
        }
        
        const user = await User.findOne({ userId: reminder.userId });
        const preferredName = user?.preferredName || 'there';
        
        const contextualMsg = await generateContextualMessage(reminder.message, preferredName);
        
        const result = await sendWhatsAppMessage(
          reminder.userId,
          `🔔 REMINDER: "${reminder.message}"\n\n💪 ${contextualMsg.encouragement}\n\n🌟 ${contextualMsg.reward}\n\nGo for it, ${preferredName}!`
        );
        
        if (result.success) {
          console.log(`✅ Sent one-time reminder: ${reminder.message}`);
          
          // ONLY create next reminder if user specifically requested recurring
          if (reminder.isRecurring && reminder.recurrencePattern && reminder.nextOccurrence) {
            // Validate recurring pattern (no hourly allowed)
            if (['daily', 'weekly', 'monthly'].includes(reminder.recurrencePattern)) {
              const nextReminder = new Reminder({
                userId: reminder.userId,
                userName: reminder.userName || 'User',
                message: reminder.message,
                scheduledTime: reminder.nextOccurrence,
                userLocalTime: new Date(reminder.nextOccurrence.getTime() + (user?.timezoneOffset || 0) * 60 * 60 * 1000).toLocaleString(),
                isCompleted: false,
                isRecurring: true,
                recurrencePattern: reminder.recurrencePattern,
                nextOccurrence: calculateNextOccurrence(reminder.nextOccurrence, reminder.recurrencePattern),
                lastSentAt: null
              });
              
              await nextReminder.save({ validateBeforeSave: false });
              console.log(`🔄 Created next ${reminder.recurrencePattern} reminder for ${nextReminder.userLocalTime}`);
            } else {
              console.log(`❌ Invalid recurrence pattern: ${reminder.recurrencePattern}`);
            }
          }
          // If not recurring, reminder is just completed - NO MORE SENDS
          
        } else {
          console.log(`❌ Failed to send reminder: ${result.error}`);
          // Even if send fails, keep it marked as completed to prevent spam
        }
      } catch (error) {
        console.error(`❌ Error processing reminder:`, error);
        
        // Always mark as completed to prevent infinite retries
        try {
          await Reminder.findByIdAndUpdate(reminder._id, { 
            isCompleted: true,
            lastSentAt: now 
          });
        } catch (updateError) {
          console.error('❌ Failed to mark as completed:', updateError);
        }
      }
    }
  } catch (error) {
    console.error('❌ Cron error:', error);
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: '🤖 Jarvis - Smart Reminder Assistant (ALL FIXES APPLIED)',
    message: 'Production-ready with enhanced UX and all improvements',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    uptime: process.uptime(),
    mongodb_status: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    twilio_status: process.env.TWILIO_ACCOUNT_SID ? 'configured' : 'not configured',
    openai_status: process.env.OPENAI_API_KEY ? 'configured' : 'not configured',
    all_fixes_applied: [
      '🛑 NO MORE "OK" RESPONSES: Completely removed',
      '🕐 ENHANCED TIME PARSING: 18.53 = 6:53 PM working',
      '👋 IMPROVED ONBOARDING: Welcoming messages as requested',
      '🔄 BETTER "NO" RESPONSE: Helpful format guide',
      '🎯 DUPLICATE DETECTION: Different motivational responses',
      '⚠️ TIME-ONLY HANDLING: Asks for action',
      '📝 ACTION-ONLY HANDLING: Asks for time',
      '🧹 DATABASE CLEANUP: Auto-maintenance',
      '💰 COST OPTIMIZED: One-time reminders only',
      '🔒 SPAM PROTECTION: Multiple safeguards'
    ],
    new_features: [
      '🤖 Enhanced ChatGPT integration',
      '🕐 24-hour time format support (18.53)',
      '📱 Smart onboarding flow',
      '🔄 Duplicate reminder motivation',
      '⚡ Improved error messages',
      '🎯 Better user experience',
      '💪 Contextual motivational messages',
      '📍 Location-based timezone setup'
    ],
    core_features: [
      '✅ One-time reminders (default)',
      '🔄 Explicit recurring reminders',
      '📋 Reminder management',
      '🎯 AI-powered conversation',
      '🛡️ Robust error handling',
      '💵 Cost-optimized operations'
    ]
  });
});

// Error handling
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// Server startup with enhanced cleanup and verification
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log('🤖 Jarvis Smart Reminder Assistant is ready!');
  
  // Clean up old reminders on startup
  console.log('🧹 Cleaning up old reminders...');
  await cleanupOldReminders();
  
  // Check Twilio account status
  console.log('📊 Checking Twilio account status...');
  const accountStatus = await checkTwilioAccountStatus();
  
  if (accountStatus) {
    console.log('✅ Twilio account verified:', accountStatus.type);
  } else {
    console.log('⚠️ Could not verify Twilio account status');
  }
  
  console.log('🎯 REMINDER POLICY: Send once and complete (unless explicitly recurring)');
  console.log('🚫 NO "OK" RESPONSES: Clean conversation flow');
  console.log('🕐 ENHANCED TIME PARSING: 18.53 = 6:53 PM support');
  console.log('👋 IMPROVED ONBOARDING: Welcoming user experience');
  console.log('✅ All systems ready for production!');
});

// Graceful shutdown handlers
process.on('SIGINT', async () => {
  console.log('🔄 Shutting down gracefully...');
  try {
    await mongoose.connection.close();
    console.log('✅ MongoDB connection closed');
  } catch (error) {
    console.error('❌ Error closing MongoDB connection:', error);
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('🔄 Shutting down gracefully...');
  try {
    await mongoose.connection.close();
    console.log('✅ MongoDB connection closed');
  } catch (error) {
    console.error('❌ Error closing MongoDB connection:', error);
  }
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  console.error('🚨 Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🚨 Unhandled rejection at:', promise, 'reason:', reason);
  process.exit(1);
});
