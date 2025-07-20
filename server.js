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

// ENHANCED User Schema with personalization tracking
const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  userName: { type: String, required: true },
  preferredName: { type: String, default: null },
  location: { type: String, default: null },
  timezoneOffset: { type: Number, default: 0 },
  reminderCount: { type: Number, default: 0 },
  lastResetDate: { type: Date, default: Date.now },
  isSetup: { type: Boolean, default: false },
  pendingReminder: { type: Object, default: null },
  
  // PERSONALIZATION FIELDS
  communicationStyle: { 
    type: String, 
    enum: ['casual', 'formal', 'energetic', 'supportive', 'direct'], 
    default: 'casual' 
  },
  preferredResponses: { type: [String], default: [] }, // Track which responses they like
  messageHistory: { type: Number, default: 0 }, // Count of interactions
  lastInteractionTone: { type: String, default: 'neutral' },
  
  // PREMIUM FIELDS
  isPremium: { type: Boolean, default: false },
  premiumExpiresAt: { type: Date, default: null },
  subscriptionId: { type: String, default: null },
  paymentMethod: { type: String, default: null },
  upgradeDate: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// Reminder Schema
const reminderSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  userName: { type: String, default: 'User' },
  message: { type: String, required: true },
  scheduledTime: { type: Date, required: true },
  userLocalTime: { type: String, default: 'Scheduled' },
  userTimezone: { type: Number, default: 0 },
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
  FREE_TIER_REMINDERS: 5,
  RESET_PERIOD_HOURS: 24
};

// PERSONALIZATION: Analyze user communication style
function analyzeUserTone(messageText) {
  const text = messageText.toLowerCase();
  
  // Casual indicators
  if (text.includes('yo') || text.includes('bro') || text.includes('lol') || 
      text.includes('tbh') || text.includes('ngl') || text.includes('rn')) {
    return 'casual';
  }
  
  // Energetic indicators
  if (text.includes('!') || text.includes('yes!') || text.includes('awesome') || 
      text.includes('amazing') || text.includes('love') || text.includes('excited')) {
    return 'energetic';
  }
  
  // Supportive/emotional indicators
  if (text.includes('please') || text.includes('help') || text.includes('thanks') || 
      text.includes('appreciate') || text.includes('😭') || text.includes('🙏')) {
    return 'supportive';
  }
  
  // Direct indicators
  if (text.length < 10 || (!text.includes('please') && !text.includes('thank'))) {
    return 'direct';
  }
  
  return 'formal';
}

// PERSONALIZATION: Generate adaptive responses
function getPersonalizedResponse(type, user, context = {}) {
  const style = user.communicationStyle || 'casual';
  const name = user.preferredName || 'there';
  
  const responses = {
    confirmation: {
      casual: ['Gotcha! 😎', 'All set!', 'Locked in!', 'We\'re on it!', 'Done deal! 🤝'],
      formal: ['Reminder confirmed.', 'I\'ve scheduled that for you.', 'All set, thank you.', 'Confirmed.'],
      energetic: ['YES! Got it! 🚀', 'Boom! Scheduled! 💥', 'Let\'s gooo! 🔥', 'Locked and loaded! ⚡'],
      supportive: ['I\'ve got you covered 🫡', 'Don\'t worry, I\'ll remind you 💙', 'Consider it done! 🤗', 'I\'m here for you!'],
      direct: ['Set.', 'Done.', 'Scheduled.', 'Got it.']
    },
    
    motivation: {
      casual: ['You got this! 💪', 'Let\'s make it happen!', 'Time to shine! ✨', 'Show time! 🌟'],
      formal: ['Best of luck with your task.', 'I hope this helps you stay organized.', 'Wishing you success.'],
      energetic: ['CRUSH IT! 🔥', 'You\'re unstoppable! 🚀', 'GO GET \'EM! 💥', 'BEAST MODE! 🦁'],
      supportive: ['I believe in you 💙', 'You\'ve got this, I promise 🤗', 'Taking care of yourself matters 💜', 'One step at a time 🌸'],
      direct: ['Do it.', 'Time to go.', 'Make it happen.', 'Execute.']
    },
    
    premium_upsell: {
      casual: ['That\'s a premium thing! But hey, maybe you\'ll be among the first to try? 😉', 'Wish I could! Premium\'s got the good stuff though 🚀'],
      formal: ['That feature is available with our premium service.', 'Premium users have access to that functionality.'],
      energetic: ['Ooh that\'s PREMIUM territory! The upgrade is totally worth it! 🌟', 'Premium unlocks the magic! ✨'],
      supportive: ['I wish I could help with that! Premium has some amazing features though 💙', 'Premium users get the full experience 🤗'],
      direct: ['Premium feature.', 'Upgrade needed.', 'Premium only.']
    }
  };
  
  const typeResponses = responses[type] || responses.confirmation;
  const styleResponses = typeResponses[style] || typeResponses.casual;
  
  return styleResponses[Math.floor(Math.random() * styleResponses.length)];
}

// PERSONALIZATION: Update user communication style
async function updateUserPersonalization(user, messageText) {
  const detectedTone = analyzeUserTone(messageText);
  
  // Update communication style based on consistency
  if (user.lastInteractionTone === detectedTone || user.messageHistory < 3) {
    user.communicationStyle = detectedTone;
  }
  
  user.lastInteractionTone = detectedTone;
  user.messageHistory += 1;
  
  await user.save();
}

// Usage check function
async function checkUsageLimits(user) {
  const now = new Date();
  
  if (user.isPremium) {
    if (user.premiumExpiresAt && user.premiumExpiresAt < now) {
      user.isPremium = false;
      user.premiumExpiresAt = null;
      console.log(`⬇️ Premium expired for user ${user.userId}`);
      await user.save();
    } else {
      return {
        withinReminderLimit: true,
        remainingReminders: 999999,
        isPremium: true
      };
    }
  }
  
  const userNow = new Date(now.getTime() + (user.timezoneOffset * 60 * 60 * 1000));
  const userLastReset = new Date(user.lastResetDate.getTime() + (user.timezoneOffset * 60 * 60 * 1000));
  
  const isSameDay = userNow.toDateString() === userLastReset.toDateString();
  
  if (!isSameDay) {
    console.log(`🔄 Daily reset for user ${user.userId}`);
    user.reminderCount = 0;
    user.lastResetDate = now;
    await user.save();
  }
  
  return {
    withinReminderLimit: user.reminderCount < USAGE_LIMITS.FREE_TIER_REMINDERS,
    remainingReminders: Math.max(0, USAGE_LIMITS.FREE_TIER_REMINDERS - user.reminderCount),
    isPremium: false
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
        max_tokens: 300,
        temperature: 0.3
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
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

// FIXED: Smart message analyzer - ONLY weather/chat/lifestyle are premium
async function analyzeMessage(messageText, userName) {
  const systemMessage = `You are Jarvis, a warm, context-aware reminder assistant. Analyze the user's message for intent and emotional state.

CORE REMINDER FEATURES (ALWAYS FREE):
- Set reminders with specific times ("gym at 7pm", "meeting tomorrow at 2pm")
- List active reminders ("list", "show reminders", "my reminders")
- Cancel/delete reminders ("cancel gym", "delete reminder 2")
- Change/edit reminders ("change gym to 8pm", "move dentist to tomorrow")
- Change user name ("call me John")
- Basic help about reminder features

PREMIUM FEATURES ONLY:
- Weather questions ("what's the weather?", "will it rain?")
- Lifestyle/personal advice ("what should I eat?", "relationship advice")
- General conversation/chat ("how are you?", "tell me a joke")
- Complex analysis ("analyze my schedule", "productivity tips")
- Non-reminder questions ("what time is it?", "latest news")

FRUSTRATION DETECTION:
Detect frustration in words like: stupid, useless, terrible, horrible, hate, angry, frustrated, doesn't work, broken, etc.

User message: "${messageText}"

Respond with JSON only:
{
  "intent": "reminder|list|cancel|edit|premium|name_change|weather|chat|non_reminder",
  "isReminder": true/false,
  "hasAction": true/false,
  "hasTime": true/false,
  "task": "what they want to be reminded about (if reminder)",
  "timeExpression": "any time found (if reminder)",
  "questionAnswer": "helpful answer (if basic question about bot features)",
  "premiumRequired": false,
  "userFrustration": true/false,
  "empathyResponse": "apologetic, understanding response if user is frustrated",
  "confidence": 0.9,
  "needsClarification": true/false
}

EXAMPLES - MARK THESE AS FREE:
- "gym at 8pm today" → {"intent": "reminder", "isReminder": true, "hasAction": true, "hasTime": true, "task": "gym", "timeExpression": "8pm today", "premiumRequired": false}
- "list reminders" → {"intent": "list", "isReminder": false, "premiumRequired": false}
- "cancel gym" → {"intent": "cancel", "isReminder": false, "premiumRequired": false}
- "change gym to 8pm" → {"intent": "edit", "isReminder": false, "premiumRequired": false}

MARK THESE AS PREMIUM:
- "what's the weather?" → {"intent": "weather", "premiumRequired": true, "questionAnswer": "Weather updates are a premium feature!"}
- "how are you?" → {"intent": "chat", "premiumRequired": true, "questionAnswer": "Casual chat is a premium feature!"}

CRITICAL: Mark premiumRequired=false for ALL basic reminder functionality including list, cancel, edit.`;

  try {
    const result = await askChatGPT(messageText, systemMessage);
    return result || { intent: "non_reminder", premiumRequired: false };
  } catch (error) {
    console.error('Error analyzing message:', error);
    return { intent: "non_reminder", premiumRequired: false };
  }
}

// FIXED: Simple command detection - MARK ALL BASIC COMMANDS AS FREE
function detectSimpleCommand(messageText) {
  const text = messageText.toLowerCase().trim();
  
  // LIST COMMANDS - FREE
  if (text === 'list' || text === 'list reminders' || text === 'show reminders' || 
      text === 'my reminders' || text === 'reminders' || text === 'show my reminders') {
    return 'list';
  }
  
  // PREMIUM COMMAND
  if (text === 'premium' || text === 'upgrade') {
    return 'premium';
  }
  
  // CANCEL COMMANDS - FREE
  if (text.includes('cancel') || text.includes('delete')) {
    return 'cancel';
  }
  
  // EDIT COMMANDS - FREE
  if (text.includes('change') || text.includes('move') || text.includes('edit') || text.includes('update')) {
    return 'edit';
  }
  
  // NAME CHANGE - FREE
  if ((text.includes('call me') || text.includes('name') || text.includes('i am') || text.includes("i'm")) && 
      !text.includes('remind') && !text.includes('at ') && !text.includes('tomorrow')) {
    return 'name_change';
  }
  
  return null;
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

// PERSONALIZED: Contextual motivational message generation
async function generateContextualMessage(task, userName, userStyle = 'casual') {
  const systemMessage = `Create a very short, encouraging reminder message that matches the user's communication style.

Task: "${task}"
User: ${userName}
Style: ${userStyle}

Match their style:
- casual: Use emojis, friendly tone, relatable language
- formal: Professional, polite, straightforward  
- energetic: Enthusiastic, caps, exciting emojis
- supportive: Gentle, caring, encouraging
- direct: Very brief, action-oriented

Keep it under 15 words total. Be motivational but concise.

Respond with JSON only:
{
  "message": "short encouraging message matching their style"
}`;

  try {
    const result = await askChatGPT(`${task} - ${userStyle}`, systemMessage);
    return result?.message || getPersonalizedResponse('motivation', { communicationStyle: userStyle });
  } catch (error) {
    console.error('Error generating contextual message:', error);
    return getPersonalizedResponse('motivation', { communicationStyle: userStyle });
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
      createdAt: { $gt: new Date(Date.now() - 24 * 60 * 60 * 1000) }
    });
    return !!similar;
  } catch (error) {
    console.error('Error checking duplicates:', error);
    return false;
  }
}

// ENHANCED: Cancel reminder function
async function handleCancelReminder(userId, messageText, userName) {
  try {
    const reminders = await Reminder.find({ 
      userId: userId, 
      isCompleted: false,
      scheduledTime: { $gt: new Date() }
    }).sort({ scheduledTime: 1 });
    
    if (reminders.length === 0) {
      return `No active reminders to cancel, ${userName}! 📋\n\nTry: "gym at 7pm today" to create one`;
    }
    
    const numberMatch = messageText.match(/(\d+)/);
    const keywordMatch = messageText.toLowerCase();
    
    let reminderToCancel = null;
    
    if (numberMatch) {
      const index = parseInt(numberMatch[1]) - 1;
      if (index >= 0 && index < reminders.length) {
        reminderToCancel = reminders[index];
      }
    } else {
      reminderToCancel = reminders.find(r => 
        keywordMatch.includes(r.message.toLowerCase().split(' ')[0])
      );
    }
    
    if (reminderToCancel) {
      await Reminder.findByIdAndUpdate(reminderToCancel._id, { isCompleted: true });
      return `✅ Canceled: "${reminderToCancel.message}"\n📅 Was scheduled for: ${reminderToCancel.userLocalTime}`;
    } else {
      let response = `Which reminder do you want to cancel? 🤔\n\n`;
      reminders.forEach((reminder, index) => {
        response += `${index + 1}. ${reminder.message}\n   📅 ${reminder.userLocalTime}\n\n`;
      });
      response += `Reply with:\n• Number: "cancel 2"\n• Keyword: "cancel gym"`;
      return response;
    }
    
  } catch (error) {
    console.error('Error handling cancel reminder:', error);
    return `❌ Error canceling reminder. Please try again.`;
  }
}

// ENHANCED: Edit reminder function
async function handleReminderEdit(userId, messageText, userName) {
  try {
    const editPatterns = [
      /change\s+(.+?)\s+to\s+(.+)/i,
      /move\s+(.+?)\s+to\s+(.+)/i,
      /reschedule\s+(.+?)\s+to\s+(.+)/i,
      /update\s+(.+?)\s+to\s+(.+)/i
    ];

    let editMatch = null;
    for (const pattern of editPatterns) {
      editMatch = messageText.match(pattern);
      if (editMatch) break;
    }

    if (!editMatch) return null;

    const reminderKeyword = editMatch[1].trim();
    const newTime = editMatch[2].trim();

    const reminders = await Reminder.find({
      userId: userId,
      isCompleted: false,
      message: { $regex: new RegExp(reminderKeyword, 'i') }
    });

    if (reminders.length === 0) {
      return `❌ Couldn't find a reminder matching "${reminderKeyword}".\n\nTry: "list reminders" to see all your reminders.`;
    }

    if (reminders.length > 1) {
      let response = `🤔 Found multiple reminders matching "${reminderKeyword}":\n\n`;
      reminders.forEach((reminder, index) => {
        response += `${index + 1}. ${reminder.message}\n   📅 ${reminder.userLocalTime}\n\n`;
      });
      response += `Reply with "change reminder 2 to ${newTime}" to specify which one.`;
      return response;
    }

    const user = await User.findOne({ userId });
    const newTimeData = parseReminderWithTimezone(`reminder ${newTime}`, reminders[0].message, user.timezoneOffset);

    if (!newTimeData) {
      return `❌ Couldn't understand the time "${newTime}".\n\nTry formats like:\n• "8pm today"\n• "tomorrow at 2pm"\n• "Monday at 9am"`;
    }

    await Reminder.findByIdAndUpdate(reminders[0]._id, {
      scheduledTime: newTimeData.scheduledTime,
      userLocalTime: newTimeData.userLocalTime
    });

    return `✅ Updated reminder!\n\n"${reminders[0].message}"\n📅 New time: ${newTimeData.userLocalTime}`;
  } catch (error) {
    console.error('Error handling edit reminder:', error);
    return `❌ Error updating reminder. Please try again.`;
  }
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

// FIXED: Precise time parsing with better timezone handling
function parseReminderWithTimezone(messageText, task, timezoneOffset = 0) {
  try {
    let parsed = null;
    
    console.log(`🕐 Parsing time: "${messageText}" with timezone offset: ${timezoneOffset}`);
    
    const now = new Date();
    const userNow = new Date(now.getTime() + (timezoneOffset * 60 * 60 * 1000));
    
    // Try chrono first
    try {
      parsed = chrono.parseDate(messageText, userNow);
    } catch (e) {
      console.log('Chrono failed, trying manual parsing');
    }
    
    if (!parsed) {
      // Handle 24-hour format
      const time24Match = messageText.match(/(\d{1,2})[.:](\d{2})/);
      if (time24Match) {
        const hours = parseInt(time24Match[1]);
        const minutes = parseInt(time24Match[2]);
        
        if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
          const timeToday = new Date(userNow);
          timeToday.setHours(hours, minutes, 0, 0);
          
          const bufferTime = new Date(userNow.getTime() + 60 * 1000);
          
          if (timeToday > bufferTime) {
            parsed = timeToday;
          } else {
            const tomorrow = new Date(timeToday);
            tomorrow.setDate(tomorrow.getDate() + 1);
            parsed = tomorrow;
          }
        }
      }
    }
    
    if (!parsed) {
      // Handle AM/PM format
      const timeMatch = messageText.match(/(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i);
      if (timeMatch) {
        const timeStr = timeMatch[1];
        
        try {
          const timeToday = chrono.parseDate(`today at ${timeStr}`, userNow);
          const bufferTime = new Date(userNow.getTime() + 60 * 1000);
          
          if (timeToday && timeToday > bufferTime) {
            parsed = timeToday;
          } else {
            parsed = chrono.parseDate(`tomorrow at ${timeStr}`, userNow);
          }
        } catch (e) {
          console.log('Failed to parse with chrono:', timeStr);
        }
      }
    }
    
    if (!parsed) {
      // Handle relative terms
      if (messageText.toLowerCase().includes('morning')) {
        const morning = new Date(userNow);
        morning.setHours(8, 0, 0, 0);
        if (morning <= userNow) {
          morning.setDate(morning.getDate() + 1);
        }
        parsed = morning;
      } else if (messageText.toLowerCase().includes('evening')) {
        const evening = new Date(userNow);
        evening.setHours(18, 0, 0, 0);
        if (evening <= userNow) {
          evening.setDate(evening.getDate() + 1);
        }
        parsed = evening;
      } else if (messageText.toLowerCase().includes('tomorrow')) {
        const tomorrow = new Date(userNow);
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(9, 0, 0, 0);
        parsed = tomorrow;
      }
    }
    
    if (!parsed) {
      console.log('❌ Could not parse time from:', messageText);
      return null;
    }
    
    // Convert to UTC for storage
    const utcTime = new Date(parsed.getTime() - (timezoneOffset * 60 * 60 * 1000));
    
    console.log(`✅ Final result - User local: ${parsed.toISOString()}, UTC: ${utcTime.toISOString()}`);
    
    return {
      message: task,
      scheduledTime: utcTime,
      userLocalTime: parsed.toLocaleString(),
      userTimezone: timezoneOffset
    };
  } catch (error) {
    console.error('❌ Error parsing reminder:', error);
    return null;
  }
}

// Enhanced cleanup function
async function cleanupOldReminders() {
  try {
    const now = new Date();
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    
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
    
    const deleteResult = await Reminder.deleteMany({
      isCompleted: true,
      createdAt: { $lt: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) }
    });
    
    console.log(`🗑️ Deleted ${deleteResult.deletedCount} old completed reminders`);
    
  } catch (error) {
    console.error('❌ Cleanup error:', error);
  }
}

// Function to upgrade user to premium
async function upgradeToPremium(phoneNumber, paymentMethod, subscriptionId) {
  try {
    const userId = phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`;
    
    const user = await User.findOne({ userId });
    if (!user) {
      console.error(`❌ User not found for upgrade: ${userId}`);
      return;
    }
    
    const premiumExpiry = new Date();
    premiumExpiry.setMonth(premiumExpiry.getMonth() + 1);
    
    user.isPremium = true;
    user.premiumExpiresAt = premiumExpiry;
    user.subscriptionId = subscriptionId;
    user.paymentMethod = paymentMethod;
    user.upgradeDate = new Date();
    
    await user.save();
    
    const userName = user.preferredName || 'there';
    const welcomeMsg = getPersonalizedResponse('premium_welcome', user, { expiryDate: premiumExpiry.toLocaleDateString() });
    
    await sendWhatsAppMessage(userId, `🎉 Welcome to Premium, ${userName}! ✨\n\n💎 You now have:\n✅ Unlimited reminders\n✅ Weather updates & casual chat\n✅ Priority support\n✅ All premium features\n\n📅 Valid until: ${premiumExpiry.toLocaleDateString()}\n\nThank you for upgrading! 🙏`);
    
    console.log(`✅ Successfully upgraded ${userId} to premium until ${premiumExpiry}`);
  } catch (error) {
    console.error('❌ Error upgrading user to premium:', error);
  }
}

// PAYMENT WEBHOOK ENDPOINTS
app.post('/webhook/stripe', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = JSON.parse(req.body);
    
    if (event.type === 'checkout.session.completed' || event.type === 'invoice.payment_succeeded') {
      const session = event.data.object;
      const phoneNumber = session.metadata?.phone_number;
      
      if (phoneNumber) {
        await upgradeToPremium(phoneNumber, 'stripe', session.id);
        console.log(`✅ Upgraded user ${phoneNumber} to premium via Stripe`);
      }
    }
    
    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Stripe webhook error:', error);
    res.sendStatus(400);
  }
});

app.post('/webhook/paypal', async (req, res) => {
  try {
    const event = req.body;
    
    if (event.event_type === 'PAYMENT.SALE.COMPLETED' || event.event_type === 'BILLING.SUBSCRIPTION.ACTIVATED') {
      const phoneNumber = event.resource?.custom;
      
      if (phoneNumber) {
        await upgradeToPremium(phoneNumber, 'paypal', event.id);
        console.log(`✅ Upgraded user ${phoneNumber} to premium via PayPal`);
      }
    }
    
    res.sendStatus(200);
  } catch (error) {
    console.error('❌ PayPal webhook error:', error);
    res.sendStatus(400);
  }
});

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

// MAIN webhook for receiving messages
app.post('/webhook', async (req, res) => {
  res.type('text/xml');
  res.send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  
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
      
      try {
        await handleIncomingMessage(message, contact);
      } catch (error) {
        console.error('❌ Message handling error:', error);
        await sendWhatsAppMessage(phoneNumber, '❌ Sorry, I encountered an error. Please try again.');
      }
    }
  } catch (error) {
    console.error('❌ Webhook processing error:', error);
  }
});

// UPDATED: Main message handler with PERSONALIZATION and FIXED premium logic
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

    // Update personalization based on message
    await updateUserPersonalization(user, messageText);

    // ONBOARDING FLOW - Following the document requirements
    if (!user.isSetup) {
      if (!user.preferredName) {
        // Check if they sent a reminder request instead of name
        const simpleCommand = detectSimpleCommand(messageText);
        if (!simpleCommand) {
          const analysis = await analyzeMessage(messageText, userName);
          
          if (analysis && analysis.isReminder) {
            await sendWhatsAppMessage(userId, `Hey hey 👋 I'm your assistant here to keep your day on track and motivate you too!\n\nBefore we begin — what should I call you?`);
            
            user.pendingReminder = {
              originalMessage: messageText,
              needsProcessing: true
            };
            await user.save();
            return;
          }
        }
        
        const cleanName = messageText.replace(/[^a-zA-Z\s]/g, '').trim();
        if (cleanName && cleanName.length > 0 && cleanName.length < 20) {
          user.preferredName = cleanName;
          await user.save();
          
          await sendWhatsAppMessage(userId, `Great to meet you, ${cleanName}! 🙌\n\nWhat's your location? (e.g., "Istanbul", "New York")\n\nThis helps me set accurate reminder times.`);
        } else {
          await sendWhatsAppMessage(userId, `Hey hey 👋 I'm your assistant here to keep your day on track and motivate you too!\n\nBefore we begin — what should I call you?`);
        }
        return;
      }
      
      if (!user.location) {
        const timezoneInfo = await detectLocationTimezone(messageText);
        if (timezoneInfo) {
          user.location = timezoneInfo.location;
          user.timezoneOffset = timezoneInfo.timezoneOffset;
          user.isSetup = true;
          
          let welcomeMsg = `${timezoneInfo.confirmation}\n\n✅ Setup complete!\n\nNow just tell me what you'd like to be reminded about.\n\nYou can say things like:\n📌 Call mom on 18.07 at 9pm\n📌 Drink water every day at 9am\n📌 Dentist appointment tomorrow at 3pm`;
          
          if (user.pendingReminder && user.pendingReminder.needsProcessing) {
            welcomeMsg += `\n\n💡 I'll process your earlier reminder request now!`;
            
            const pendingMessage = user.pendingReminder.originalMessage;
            user.pendingReminder = null;
            await user.save();
            
            await sendWhatsAppMessage(userId, welcomeMsg);
            
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

    // Handle pending reminder confirmations
    if (user.pendingReminder && (messageText.toLowerCase() === 'yes' || messageText.toLowerCase() === 'y')) {
      const usageCheck = await checkUsageLimits(user);
      if (!usageCheck.withinReminderLimit && !usageCheck.isPremium) {
        user.pendingReminder = null;
        await user.save();
        
        const upsellMsg = getPersonalizedResponse('premium_upsell', user);
        await sendWhatsAppMessage(userId, `🚫 That's your 5th reminder for today ✅\n\nWant more flexibility, voice reminders, and smart support?\n🚀 ${upsellMsg}`);
        return;
      }
      
      const pendingData = user.pendingReminder;
      
      try {
        const isDuplicate = await isDuplicateReminder(userId, pendingData.message);
        
        const reminder = new Reminder({
          userId: userId,
          userName: userName || 'User',
          message: pendingData.message || 'Reminder',
          scheduledTime: pendingData.scheduledTime || new Date(),
          userLocalTime: pendingData.userLocalTime || new Date().toLocaleString(),
          userTimezone: pendingData.userTimezone || user.timezoneOffset,
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
        
        const confirmationMsg = getPersonalizedResponse('confirmation', user);
        
        if (isDuplicate) {
          await sendWhatsAppMessage(userId, `${confirmationMsg} I see you really want to remember "${pendingData.message}" - that's great commitment!\n\n📅 ${pendingData.userLocalTime || 'Scheduled'}`);
        } else {
          await sendWhatsAppMessage(userId, `${confirmationMsg}\n\n"${pendingData.message}"\n📅 ${pendingData.userLocalTime || 'Scheduled'}`);
        }
      } catch (saveError) {
        console.error('❌ Error saving reminder:', saveError);
        await sendWhatsAppMessage(userId, `❌ Error saving reminder. Please try again.`);
      }
      return;
    }
    
    // Handle "no" response
    if (user.pendingReminder && (messageText.toLowerCase() === 'no' || messageText.toLowerCase() === 'n')) {
      user.pendingReminder = null;
      await user.save();
      
      await sendWhatsAppMessage(userId, `No problem! Just send your reminder again with the time included. 👍`);
      return;
    }
    
    // FIXED: Check simple commands first - ALL BASIC COMMANDS ARE FREE
    const simpleCommand = detectSimpleCommand(messageText);
    
    if (simpleCommand === 'list') {
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
    
    if (simpleCommand === 'cancel') {
      const cancelResponse = await handleCancelReminder(userId, messageText, user.preferredName);
      await sendWhatsAppMessage(userId, cancelResponse);
      return;
    }
    
    if (simpleCommand === 'edit') {
      const editResponse = await handleReminderEdit(userId, messageText, user.preferredName);
      if (editResponse) {
        await sendWhatsAppMessage(userId, editResponse);
        return;
      }
    }
    
    if (simpleCommand === 'premium') {
      if (user.isPremium) {
        const expiryDate = user.premiumExpiresAt ? user.premiumExpiresAt.toLocaleDateString() : 'Never';
        await sendWhatsAppMessage(userId, `💎 You're already Premium! ✨\n\n🎉 Enjoying unlimited reminders\n📅 Valid until: ${expiryDate}\n\n❤️ Thanks for supporting us!`);
      } else {
        const premiumMsg = getPersonalizedResponse('premium_upsell', user);
        await sendWhatsAppMessage(userId, `💎 Premium Features:\n\n✅ Unlimited daily reminders\n✅ Weather updates & casual chat\n✅ Voice note reminders 🎤\n✅ Priority support\n\n💰 Only $4.99/month\n\n🔗 ${premiumMsg}`);
      }
      return;
    }
    
    if (simpleCommand === 'name_change') {
      const nameChange = isNameChange(messageText);
      if (nameChange) {
        user.preferredName = nameChange;
        await user.save();
        const confirmMsg = getPersonalizedResponse('confirmation', user);
        await sendWhatsAppMessage(userId, `${confirmMsg} I'll call you ${nameChange}.`);
        return;
      }
    }
    
    // SMART ANALYSIS: Use ChatGPT for complex messages only
    let analysis = null;
    try {
      console.log('🤖 Using ChatGPT for smart analysis...');
      analysis = await analyzeMessage(messageText, user.preferredName);
    } catch (error) {
      console.error('Analysis failed:', error);
      analysis = { intent: "reminder", premiumRequired: false };
    }
    
    // HANDLE USER FRUSTRATION FIRST - PERSONALIZED EMPATHY
    if (analysis.userFrustration && analysis.empathyResponse) {
      await sendWhatsAppMessage(userId, analysis.empathyResponse);
      return;
    }
    
    // Handle ONLY genuine premium requests (weather, chat, lifestyle)
    if (analysis.premiumRequired) {
      if (user.isPremium) {
        await sendWhatsAppMessage(userId, analysis.questionAnswer || "I'd love to help with that! As a premium user, you have access to all my features.");
      } else {
        const premiumMsg = getPersonalizedResponse('premium_upsell', user);
        
        // PERSONALIZED premium responses based on user style
        if (user.communicationStyle === 'casual') {
          await sendWhatsAppMessage(userId, `${analysis.questionAnswer || "That's a premium thing!"} But hey, maybe you'll be among the first to try? 😉\n\n💎 ${premiumMsg}`);
        } else if (user.communicationStyle === 'energetic') {
          await sendWhatsAppMessage(userId, `${analysis.questionAnswer || "Ooh that's PREMIUM territory!"} The upgrade is totally worth it! 🌟\n\n💎 ${premiumMsg}`);
        } else {
          await sendWhatsAppMessage(userId, `${analysis.questionAnswer || "That feature is available with our premium service."}\n\n💎 ${premiumMsg}`);
        }
      }
      return;
    }
    
    // Handle basic reminder functionality - FREE FOR ALL USERS
    if (analysis.intent === 'reminder' && analysis.isReminder) {
      // Check usage limits only for reminder creation
      const usageCheck = await checkUsageLimits(user);
      
      if (!usageCheck.withinReminderLimit && !usageCheck.isPremium) {
        const limitMsg = getPersonalizedResponse('premium_upsell', user);
        await sendWhatsAppMessage(userId, 
          `🚫 That's your 5th reminder for today ✅\n\nWant more flexibility, voice reminders, and smart support?\n🚀 ${limitMsg}`
        );
        return;
      }

      if (analysis.hasAction && analysis.hasTime) {
        const reminderData = parseReminderWithTimezone(messageText, analysis.task, user.timezoneOffset);
        
        if (reminderData && reminderData.scheduledTime > new Date()) {
          let confirmationMsg = `📝 Confirm reminder:\n\n"${reminderData.message}"`;
          
          const dayName = new Date(reminderData.scheduledTime.getTime() + (user.timezoneOffset * 60 * 60 * 1000)).toLocaleDateString('en-US', { weekday: 'long' });
          
          await sendWhatsAppMessage(userId, `${confirmationMsg}\n📅 ${dayName}, ${reminderData.userLocalTime}\n\nReply "yes" to confirm or "no" to cancel.`);
          
          user.pendingReminder = {
            message: reminderData.message,
            scheduledTime: reminderData.scheduledTime,
            userLocalTime: reminderData.userLocalTime,
            userTimezone: reminderData.userTimezone
          };
          await user.save();
        } else {
          await sendWhatsAppMessage(userId, `⚠️ That time has passed, ${user.preferredName}.\n\nTry: "${analysis.task} tomorrow at 9am"`);
        }
      } else if (analysis.hasAction && !analysis.hasTime) {
        // PERSONALIZED time request
        if (user.communicationStyle === 'casual') {
          await sendWhatsAppMessage(userId, `Got the task ⏰ — but when should I remind you about "${analysis.task}"?\n\nTry: "${analysis.task} at 5pm today"`);
        } else if (user.communicationStyle === 'direct') {
          await sendWhatsAppMessage(userId, `Time needed for "${analysis.task}".`);
        } else {
          await sendWhatsAppMessage(userId, `What time should I remind you about "${analysis.task}"?\n\nExample: "${analysis.task} at 5pm today"`);
        }
      } else if (!analysis.hasAction && analysis.hasTime) {
        await sendWhatsAppMessage(userId, `What should I remind you *about* at ${analysis.timeExpression}?\n\nExample: "Take medicine at ${analysis.timeExpression}"`);
      } else {
        // PERSONALIZED format help
        if (user.communicationStyle === 'casual') {
          await sendWhatsAppMessage(userId, `I can see you want to set a reminder! 😊\n\nTry this format:\n🕐 *Action + Date + Time*\n\nExample: *"Take vitamins at 8pm today"*`);
        } else {
          await sendWhatsAppMessage(userId, `Please use this format:\n*Action + Date + Time*\n\nExample: "Take vitamins at 8pm today"`);
        }
      }
      return;
    }
    
    // FALLBACK: Personalized general help
    const helpMsg = user.communicationStyle === 'casual' ? 
      `Hi ${user.preferredName}! 🤖\n\nI help you set reminders:\n\n• "gym at 7pm today"\n• "call mom at 3pm tomorrow"\n\nCommands:\n📋 "list reminders" (FREE)\n❌ "cancel reminder" (FREE)\n✏️ "change reminder" (FREE)\n💎 "premium" for upgrade` :
      `Hello ${user.preferredName}. I assist with reminders.\n\nFormat: "task at time"\nCommands: list, cancel, change, premium`;
    
    await sendWhatsAppMessage(userId, helpMsg);
    
  } catch (error) {
    console.error('❌ Handler error:', error);
    try {
      await sendWhatsAppMessage(message.from, '❌ Something went wrong. Please try again.');
    } catch (sendError) {
      console.error('❌ Send error:', sendError);
    }
  }
}

// UPDATED: Cron job with PERSONALIZED and SHORTER motivational messages
cron.schedule('*/2 * * * *', async () => {
  try {
    console.log('⏰ Checking for due reminders...');
    
    const now = new Date();
    const twoMinutesAgo = new Date(now.getTime() - 2 * 60 * 1000);
    
    const dueReminders = await Reminder.find({
      scheduledTime: { 
        $gte: twoMinutesAgo,
        $lte: now
      },
      isCompleted: false,
      lastSentAt: null
    }).limit(5);

    console.log(`⏰ Found ${dueReminders.length} due reminders`);

    for (const reminder of dueReminders) {
      try {
        const marked = await Reminder.findOneAndUpdate(
          { 
            _id: reminder._id, 
            lastSentAt: null
          },
          { 
            lastSentAt: now,
            isCompleted: true
          },
          { new: true }
        );
        
        if (!marked) {
          console.log('⏭️ Reminder already processed');
          continue;
        }
        
        const user = await User.findOne({ userId: reminder.userId });
        const preferredName = user?.preferredName || 'there';
        
        // PERSONALIZED reminder message
        const contextualMsg = await generateContextualMessage(
          reminder.message, 
          preferredName, 
          user?.communicationStyle || 'casual'
        );
        
        // SHORTER format following document guidelines
        const result = await sendWhatsAppMessage(
          reminder.userId,
          `⏰ ${preferredName}, here's your reminder:\n📝 ${reminder.message}\n\n${contextualMsg}`
        );
        
        if (result.success) {
          console.log(`✅ Sent reminder: ${reminder.message}`);
          
          // Handle recurring reminders
          if (reminder.isRecurring && reminder.recurrencePattern && reminder.nextOccurrence) {
            if (['daily', 'weekly', 'monthly'].includes(reminder.recurrencePattern)) {
              const nextReminder = new Reminder({
                userId: reminder.userId,
                userName: reminder.userName || 'User',
                message: reminder.message,
                scheduledTime: reminder.nextOccurrence,
                userLocalTime: new Date(reminder.nextOccurrence.getTime() + ((reminder.userTimezone || user?.timezoneOffset || 0) * 60 * 60 * 1000)).toLocaleString(),
                userTimezone: reminder.userTimezone || user?.timezoneOffset || 0,
                isCompleted: false,
                isRecurring: true,
                recurrencePattern: reminder.recurrencePattern,
                nextOccurrence: calculateNextOccurrence(reminder.nextOccurrence, reminder.recurrencePattern),
                lastSentAt: null
              });
              
              await nextReminder.save({ validateBeforeSave: false });
              console.log(`🔄 Created next ${reminder.recurrencePattern} reminder`);
            }
          }
        } else {
          console.log(`❌ Failed to send reminder: ${result.error}`);
        }
      } catch (error) {
        console.error(`❌ Error processing reminder:`, error);
        
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

// Daily counter reset based on individual user timezones
cron.schedule('0 * * * *', async () => {
  try {
    console.log('🕛 Checking for users needing daily reset...');
    
    const now = new Date();
    const users = await User.find({});
    let resetCount = 0;
    
    for (const user of users) {
      try {
        const userNow = new Date(now.getTime() + (user.timezoneOffset * 60 * 60 * 1000));
        const userLastReset = new Date(user.lastResetDate.getTime() + (user.timezoneOffset * 60 * 60 * 1000));
        
        const isSameDay = userNow.toDateString() === userLastReset.toDateString();
        
        if (!isSameDay) {
          user.reminderCount = 0;
          user.lastResetDate = now;
          await user.save();
          resetCount++;
          console.log(`🔄 Reset counter for user ${user.userId} (timezone: ${user.timezoneOffset})`);
        }
      } catch (error) {
        console.error(`❌ Error resetting user ${user.userId}:`, error);
      }
    }
    
    if (resetCount > 0) {
      console.log(`✅ Reset counters for ${resetCount} users`);
    }
  } catch (error) {
    console.error('❌ Daily reset error:', error);
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: '🤖 Jarvis - Smart Reminder Assistant v2.0 (With Personalization)',
    message: 'Production-ready with personalization, fixed premium logic, and enhanced UX',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    uptime: process.uptime(),
    mongodb_status: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    twilio_status: process.env.TWILIO_ACCOUNT_SID ? 'configured' : 'not configured',
    openai_status: process.env.OPENAI_API_KEY ? 'configured' : 'not configured',
    new_features: [
      '🎭 PERSONALIZATION: Adapts to user communication style',
      '📝 FIXED PREMIUM LOGIC: List/cancel/edit are now FREE',
      '💬 SHORTER MESSAGES: Concise but motivational',
      '🔄 VARIED RESPONSES: No more repetitive confirmations',
      '🎯 CONTEXTUAL ADAPTATION: Learns user preferences',
      '💙 EMPATHY HANDLING: Better frustration detection',
      '🌟 STYLE MATCHING: Mirrors user tone and energy'
    ],
    personalization_features: [
      '✅ Communication style detection (casual, formal, energetic, etc.)',
      '✅ Adaptive response generation',
      '✅ Varied confirmation messages',
      '✅ Personalized premium upsells',
      '✅ Context-aware motivational messages',
      '✅ Tone matching and preference learning'
    ]
  });
});

// Error handling
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// Server startup
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log('🤖 Jarvis Smart Reminder Assistant v2.0 is ready!');
  console.log('🎭 NEW: Personalization and adaptation features enabled!');
  console.log('📝 FIXED: List, cancel, edit reminders are now FREE');
  console.log('💬 ENHANCED: Shorter, varied, contextual messages');
  console.log('🎯 SMART: Communication style detection and matching');
  
  console.log('🧹 Cleaning up old reminders...');
  await cleanupOldReminders();
  
  console.log('✅ All systems operational with enhanced personalization!');
});

// Graceful shutdown
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
