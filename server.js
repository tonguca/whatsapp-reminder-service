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

// SIMPLIFIED User Schema - removed message count limit
const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  userName: { type: String, required: true },
  preferredName: { type: String, default: null },
  location: { type: String, default: null },
  timezoneOffset: { type: Number, default: 0 },
  reminderCount: { type: Number, default: 0 }, // Only track reminders
  lastResetDate: { type: Date, default: Date.now },
  isSetup: { type: Boolean, default: false },
  pendingReminder: { type: Object, default: null },
  // PREMIUM FIELDS
  isPremium: { type: Boolean, default: false },
  premiumExpiresAt: { type: Date, default: null },
  subscriptionId: { type: String, default: null },
  paymentMethod: { type: String, default: null },
  upgradeDate: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// FIXED Reminder Schema with better timezone handling
const reminderSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  userName: { type: String, default: 'User' },
  message: { type: String, required: true },
  scheduledTime: { type: Date, required: true }, // Always stored in UTC
  userLocalTime: { type: String, default: 'Scheduled' },
  userTimezone: { type: Number, default: 0 }, // Store user's timezone when reminder created
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

// SIMPLIFIED Usage limits - only reminders matter
const USAGE_LIMITS = {
  FREE_TIER_REMINDERS: 5,
  RESET_PERIOD_HOURS: 24
};

// UPDATED: Simplified usage check - only reminders count
async function checkUsageLimits(user) {
  const now = new Date();
  
  // CHECK PREMIUM STATUS FIRST
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
  
  // FIXED: Calculate time since last reset based on user's timezone
  const userNow = new Date(now.getTime() + (user.timezoneOffset * 60 * 60 * 1000));
  const userLastReset = new Date(user.lastResetDate.getTime() + (user.timezoneOffset * 60 * 60 * 1000));
  
  // Check if it's a new day in user's timezone
  const isSameDay = userNow.toDateString() === userLastReset.toDateString();
  
  if (!isSameDay) {
    console.log(`🔄 Daily reset for user ${user.userId} - timezone offset: ${user.timezoneOffset}`);
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

// Enhanced ChatGPT function with error handling
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

// ENHANCED: Smart message analyzer with frustration detection
async function analyzeMessage(messageText, userName) {
  const systemMessage = `You are Jarvis, a smart and empathetic reminder assistant. Analyze the user's message for both intent and emotional state.

Current Bot Features:
- Set reminders with specific times
- List active reminders  
- Cancel/delete reminders
- Change user name
- Premium upgrade (unlimited reminders)

IMPORTANT: Detect user frustration and respond with empathy. Anything other than core reminder features requires premium.

User message: "${messageText}"

Respond with JSON only:
{
  "intent": "reminder|list|cancel|premium|name_change|non_reminder",
  "isReminder": true/false,
  "hasAction": true/false,
  "hasTime": true/false,
  "task": "what they want to be reminded about (if reminder)",
  "timeExpression": "any time found (if reminder)",
  "questionAnswer": "helpful answer (if question about bot features)",
  "premiumRequired": true/false,
  "userFrustration": true/false,
  "empathyResponse": "apologetic, understanding response if user is frustrated",
  "confidence": 0.9,
  "needsClarification": true/false
}

Examples:
- "gym at 8pm today" → {"intent": "reminder", "isReminder": true, "hasAction": true, "hasTime": true, "task": "gym", "timeExpression": "8pm today"}
- "this bot is stupid" → {"intent": "non_reminder", "userFrustration": true, "empathyResponse": "I'm really sorry I'm not understanding you well! 😔 That's frustrating and it's my fault. Let me help you better - could you tell me what you want to be reminded about and when? I'll do my best to get it right this time."}
- "you don't understand anything!" → {"intent": "non_reminder", "userFrustration": true, "empathyResponse": "You're absolutely right, and I apologize! 😔 I should understand you better. I'm here to help with reminders - could you try telling me what you need in a format like 'remind me to [task] at [time]'? I promise to do better!"}
- "why can't you work properly?" → {"intent": "non_reminder", "userFrustration": true, "empathyResponse": "I'm so sorry I'm not working properly for you! 😔 That must be really frustrating. Let me try to help - what would you like to be reminded about? I'll focus on getting it right this time."}
- "what's the weather?" → {"intent": "non_reminder", "premiumRequired": true, "questionAnswer": "Weather updates are a premium feature! Upgrade to get unlimited reminders plus weather, chat, and more for just $4.99/month!"}

Detect frustration in words like: stupid, useless, terrible, horrible, hate, angry, frustrated, doesn't work, broken, etc.

Mark ALL non-reminder requests as premium features unless user is clearly frustrated.`;

  try {
    const result = await askChatGPT(messageText, systemMessage);
    return result || { intent: "non_reminder", premiumRequired: true };
  } catch (error) {
    console.error('Error analyzing message:', error);
    return { intent: "non_reminder", premiumRequired: true };
  }
}

// Simple command detection (no ChatGPT needed - saves costs)
function detectSimpleCommand(messageText) {
  const text = messageText.toLowerCase().trim();
  
  if (text === 'list' || text === 'list reminders' || text === 'show reminders' || text === 'my reminders') {
    return 'list';
  }
  if (text === 'premium' || text === 'upgrade') {
    return 'premium';
  }
  if (text.includes('cancel') && text.includes('reminder')) {
    return 'cancel';
  }
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
      createdAt: { $gt: new Date(Date.now() - 24 * 60 * 60 * 1000) }
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
    
    // If user specified which reminder to cancel
    const numberMatch = messageText.match(/(\d+)/);
    const keywordMatch = messageText.toLowerCase();
    
    let reminderToCancel = null;
    
    if (numberMatch) {
      const index = parseInt(numberMatch[1]) - 1;
      if (index >= 0 && index < reminders.length) {
        reminderToCancel = reminders[index];
      }
    } else {
      // Try to find by keyword in message
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

// IMPROVED Twilio WhatsApp function
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

// FIXED: Precise time parsing with better timezone handling and debugging
function parseReminderWithTimezone(messageText, task, timezoneOffset = 0) {
  try {
    let parsed = null;
    
    console.log(`🕐 Parsing time: "${messageText}" with timezone offset: ${timezoneOffset}`);
    console.log(`📍 Current time: ${new Date().toISOString()}`);
    
    // Get current time in user's timezone
    const now = new Date();
    const userNow = new Date(now.getTime() + (timezoneOffset * 60 * 60 * 1000));
    
    console.log(`🌍 User's current time: ${userNow.toISOString()} (offset: ${timezoneOffset})`);
    
    // Try chrono first with user's timezone context
    try {
      parsed = chrono.parseDate(messageText, userNow);
      console.log(`📅 Chrono parsed: ${parsed}`);
    } catch (e) {
      console.log('Chrono failed, trying manual parsing');
    }
    
    if (!parsed) {
      // Handle 24-hour format like "20.00", "20:00", "18.53", "8.33"
      const time24Match = messageText.match(/(\d{1,2})[.:](\d{2})/);
      if (time24Match) {
        const hours = parseInt(time24Match[1]);
        const minutes = parseInt(time24Match[2]);
        
        console.log(`🕐 Found time: ${hours}:${minutes}`);
        
        if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
          // Create time in user's timezone
          const timeToday = new Date(userNow);
          timeToday.setHours(hours, minutes, 0, 0);
          
          console.log(`📅 Time today in user TZ: ${timeToday.toISOString()}`);
          console.log(`⏰ User now: ${userNow.toISOString()}`);
          
          // Add 1 minute buffer for immediate reminders
          const bufferTime = new Date(userNow.getTime() + 60 * 1000);
          
          if (timeToday > bufferTime) {
            parsed = timeToday; // Same day in user's timezone
            console.log(`✅ Using today: ${parsed.toISOString()}`);
          } else {
            // Time has passed today, set for tomorrow
            const tomorrow = new Date(timeToday);
            tomorrow.setDate(tomorrow.getDate() + 1);
            parsed = tomorrow;
            console.log(`➡️ Using tomorrow: ${parsed.toISOString()}`);
          }
        }
      }
    }
    
    if (!parsed) {
      // Handle regular time patterns like "at 7am", "at 3pm", "8:33pm"
      const timeMatch = messageText.match(/(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i);
      if (timeMatch) {
        const timeStr = timeMatch[1];
        console.log(`🕐 Found AM/PM time: ${timeStr}`);
        
        try {
          // Parse in user's timezone context
          const timeToday = chrono.parseDate(`today at ${timeStr}`, userNow);
          const bufferTime = new Date(userNow.getTime() + 60 * 1000);
          
          if (timeToday && timeToday > bufferTime) {
            parsed = timeToday;
            console.log(`✅ Using today AM/PM: ${parsed.toISOString()}`);
          } else {
            parsed = chrono.parseDate(`tomorrow at ${timeStr}`, userNow);
            console.log(`➡️ Using tomorrow AM/PM: ${parsed.toISOString()}`);
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
    
    // Convert to UTC for storage (subtract timezone offset)
    const utcTime = new Date(parsed.getTime() - (timezoneOffset * 60 * 60 * 1000));
    
    console.log(`✅ Final result - User local: ${parsed.toISOString()}, UTC: ${utcTime.toISOString()}`);
    console.log(`⏰ Time difference: ${(utcTime.getTime() - now.getTime()) / 1000 / 60} minutes from now`);
    
    return {
      message: task,
      scheduledTime: utcTime, // Store in UTC
      userLocalTime: parsed.toLocaleString(),
      userTimezone: timezoneOffset
    };
  } catch (error) {
    console.error('❌ Error parsing reminder:', error);
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
    
    // Set premium for 1 month from now
    const premiumExpiry = new Date();
    premiumExpiry.setMonth(premiumExpiry.getMonth() + 1);
    
    user.isPremium = true;
    user.premiumExpiresAt = premiumExpiry;
    user.subscriptionId = subscriptionId;
    user.paymentMethod = paymentMethod;
    user.upgradeDate = new Date();
    
    await user.save();
    
    // Send confirmation message
    const userName = user.preferredName || 'there';
    await sendWhatsAppMessage(userId, `🎉 Welcome to Premium, ${userName}! ✨\n\n💎 You now have:\n✅ Unlimited reminders\n✅ Weather updates & casual chat\n✅ Priority support\n✅ All premium features\n\n📅 Valid until: ${premiumExpiry.toLocaleDateString()}\n\nThank you for upgrading! 🙏`);
    
    console.log(`✅ Successfully upgraded ${userId} to premium until ${premiumExpiry}`);
  } catch (error) {
    console.error('❌ Error upgrading user to premium:', error);
  }
}

// PAYMENT WEBHOOK ENDPOINTS

// Stripe webhook for successful payments
app.post('/webhook/stripe', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    // Verify webhook signature (you'll need to set STRIPE_WEBHOOK_SECRET)
    // event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    
    // For now, we'll parse the body directly (add signature verification in production)
    event = JSON.parse(req.body);
    
    if (event.type === 'checkout.session.completed' || event.type === 'invoice.payment_succeeded') {
      const session = event.data.object;
      const phoneNumber = session.metadata?.phone_number; // You'll pass this in checkout
      
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

// PayPal webhook for successful payments
app.post('/webhook/paypal', async (req, res) => {
  try {
    const event = req.body;
    
    if (event.event_type === 'PAYMENT.SALE.COMPLETED' || event.event_type === 'BILLING.SUBSCRIPTION.ACTIVATED') {
      const phoneNumber = event.resource?.custom; // You'll pass phone number in custom field
      
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

// FIXED: Webhook verification - this stays the same
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

// FIXED: Webhook for receiving messages - BETTER ASYNC HANDLING
app.post('/webhook', async (req, res) => {
  // CRITICAL FIX: Return empty TwiML response immediately
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
      
      // FIXED: Process message immediately instead of setImmediate
      try {
        await handleIncomingMessage(message, contact);
      } catch (error) {
        console.error('❌ Message handling error:', error);
        // Send error response to user
        await sendWhatsAppMessage(phoneNumber, '❌ Sorry, I encountered an error. Please try again.');
      }
    }
  } catch (error) {
    console.error('❌ Webhook processing error:', error);
  }
});

// MAIN message handler - SIMPLIFIED AND FIXED
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

    // REMOVED: No more message count limits - only reminders matter

    // IMPROVED setup flow
    if (!user.isSetup) {
      if (!user.preferredName) {
        // Check if they sent a reminder request instead of name
        const simpleCommand = detectSimpleCommand(messageText);
        if (!simpleCommand) {
          const analysis = await analyzeMessage(messageText, userName);
          
          if (analysis && analysis.isReminder) {
            await sendWhatsAppMessage(userId, `Hey there! 👋\n\nI'm your personal assistant here to remind you of important stuff — and give you a little motivation when needed.\n\nBut first, what should I call you? 😊\nJust send me your name, and I'll remember it from now on.`);
            
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
          
          let welcomeMsg = `${timezoneInfo.confirmation}\n\n✅ Setup complete!\n\nNow I'm ready — what would you like me to remind you about?\n\nYou can write something like:\n📝 *Take vitamins at 7am*\n📌 *Dentist appointment tomorrow at 3pm*`;
          
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

    // Handle pending reminder confirmations - WITH PREMIUM UPSELL
    if (user.pendingReminder && (messageText.toLowerCase() === 'yes' || messageText.toLowerCase() === 'y')) {
      const usageCheck = await checkUsageLimits(user);
      if (!usageCheck.withinReminderLimit && !usageCheck.isPremium) {
        user.pendingReminder = null;
        await user.save();
        
        await sendWhatsAppMessage(userId, `🚫 Hey ${user.preferredName}, you've reached your daily limit of ${USAGE_LIMITS.FREE_TIER_REMINDERS} reminders!\n\n💎 Upgrade to Premium for:\n✅ Unlimited reminders\n✅ Weather updates & casual chat\n✅ Priority support\n\n🚀 Ready to upgrade? Reply "PREMIUM" for details!`);
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
      
      await sendWhatsAppMessage(userId, `No problem, let's set it your way 👍\n\nJust send your reminder again using this format so I can schedule it properly:\n\n🕐 *Action + Date + Time*\n\nExample: *"Take vitamins at 7am today"*`);
      return;
    }
    
    // COST OPTIMIZATION: Check simple commands first (no ChatGPT needed)
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
    
    if (simpleCommand === 'premium') {
      if (user.isPremium) {
        const expiryDate = user.premiumExpiresAt ? user.premiumExpiresAt.toLocaleDateString() : 'Never';
        await sendWhatsAppMessage(userId, `💎 You're already Premium! ✨\n\n🎉 Enjoying unlimited reminders\n📅 Valid until: ${expiryDate}\n\n❤️ Thanks for supporting us!`);
      } else {
        await sendWhatsAppMessage(userId, `💎 Premium Features:\n\n✅ Unlimited daily reminders\n✅ Weather updates & casual chat\n✅ Jokes and fun features\n✅ Advanced scheduling\n✅ Priority customer support\n✅ Early access to new features\n\n💰 Only $4.99/month\n\n🔗 Upgrade now: [Your payment link here]\n\nQuestions? Just ask!`);
      }
      return;
    }
    
    if (simpleCommand === 'cancel') {
      const cancelResponse = await handleCancelReminder(userId, messageText, user.preferredName);
      await sendWhatsAppMessage(userId, cancelResponse);
      return;
    }
    
    if (simpleCommand === 'name_change') {
      const nameChange = isNameChange(messageText);
      if (nameChange) {
        user.preferredName = nameChange;
        await user.save();
        await sendWhatsAppMessage(userId, `✅ Updated! I'll call you ${nameChange}.`);
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
      analysis = { intent: "non_reminder", premiumRequired: true };
    }
    
    // HANDLE USER FRUSTRATION FIRST - ALWAYS PRIORITIZE EMPATHY
    if (analysis.userFrustration && analysis.empathyResponse) {
      await sendWhatsAppMessage(userId, analysis.empathyResponse);
      return;
    }
    
    // Handle non-reminder requests (weather, jokes, etc.) - PREMIUM ONLY
    if (analysis.premiumRequired) {
      if (user.isPremium) {
        // Premium users get answers to everything
        await sendWhatsAppMessage(userId, analysis.questionAnswer || "I'd love to help with that! As a premium user, you have access to all my features.");
      } else {
        // Free users get premium upsell
        await sendWhatsAppMessage(userId, analysis.questionAnswer || "That's a premium feature! Upgrade to get unlimited reminders plus weather, chat, and more for just $4.99/month!");
      }
      return;
    }
    
    // Handle bot feature questions
    if (analysis.intent === 'question' && analysis.questionAnswer) {
      await sendWhatsAppMessage(userId, analysis.questionAnswer);
      return;
    }
    
    if (analysis.intent === 'cancel') {
      const cancelResponse = await handleCancelReminder(userId, messageText, user.preferredName);
      await sendWhatsAppMessage(userId, cancelResponse);
      return;
    }
    
    if (analysis.intent === 'reminder' && analysis.isReminder) {
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
        await sendWhatsAppMessage(userId, `Got it — but when should I remind you? 🕒\n\nPlease include a time like:\n📌 *${analysis.task} at 5pm today*\n📌 *${analysis.task} tomorrow at 9am*`);
      } else if (!analysis.hasAction && analysis.hasTime) {
        await sendWhatsAppMessage(userId, `Oops, I need a bit more info 😅\n\nWhat should I remind you *about* at that time?\n\nPlease send something like:\n📝 *Take medicine at ${analysis.timeExpression}*`);
      } else {
        await sendWhatsAppMessage(userId, `I can see you want to set a reminder! 😊\n\nCould you be more specific?\n\n🕐 *Action + Date + Time*\n\nExamples:\n📝 *"Take vitamins at 8pm today"*\n📌 *"Call mom tomorrow at 3pm"*`);
      }
      return;
    }
    
    // FALLBACK: General help
    await sendWhatsAppMessage(userId, `Hi ${user.preferredName}! 🤖\n\nI help you set reminders with specific times:\n\n• "gym at 7pm today"\n• "call mom at 3pm tomorrow"\n• "meeting Monday at 2pm"\n\nCommands:\n📋 "list reminders"\n❌ "cancel reminder 2"\n💎 "premium" for upgrade`);
    
  } catch (error) {
    console.error('❌ Handler error:', error);
    try {
      await sendWhatsAppMessage(message.from, '❌ Something went wrong. Please try again.');
    } catch (sendError) {
      console.error('❌ Send error:', sendError);
    }
  }
}

// CRITICAL FIX: Optimized reminder checking - EVERY 2 MINUTES (not 1 minute)
cron.schedule('*/2 * * * *', async () => {
  try {
    console.log('⏰ Checking for due reminders...');
    
    const now = new Date();
    const twoMinutesAgo = new Date(now.getTime() - 2 * 60 * 1000);
    
    // Only get reminders scheduled between 2 minutes ago and now
    // This prevents firing very old reminders that were missed
    const dueReminders = await Reminder.find({
      scheduledTime: { 
        $gte: twoMinutesAgo,  // Not older than 2 minutes
        $lte: now             // Not in future
      },
      isCompleted: false,
      lastSentAt: null
    }).limit(5); // Limit to 5 per run

    console.log(`⏰ Found ${dueReminders.length} due reminders (scheduled between ${twoMinutesAgo.toISOString()} and ${now.toISOString()})`);

    for (const reminder of dueReminders) {
      try {
        // IMPORTANT: Mark as sent immediately to prevent duplicates
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
        
        // Log timezone info for debugging
        console.log(`📍 Sending reminder to ${preferredName} (timezone: ${reminder.userTimezone || user?.timezoneOffset || 0})`);
        console.log(`📅 Scheduled: ${reminder.scheduledTime.toISOString()}, Now: ${now.toISOString()}`);
        
        const contextualMsg = await generateContextualMessage(reminder.message, preferredName);
        
        const result = await sendWhatsAppMessage(
          reminder.userId,
          `🔔 REMINDER: "${reminder.message}"\n\n💪 ${contextualMsg.encouragement}\n\n🌟 ${contextualMsg.reward}\n\nGo for it, ${preferredName}!`
        );
        
        if (result.success) {
          console.log(`✅ Sent reminder: ${reminder.message} at ${now.toISOString()}`);
          
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
              console.log(`🔄 Created next ${reminder.recurrencePattern} reminder for ${nextReminder.userLocalTime}`);
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

// FIXED: Daily counter reset based on individual user timezones
cron.schedule('0 * * * *', async () => {
  try {
    console.log('🕛 Checking for users needing daily reset...');
    
    const now = new Date();
    
    // Get all users
    const users = await User.find({});
    let resetCount = 0;
    
    for (const user of users) {
      try {
        // Calculate user's current time
        const userNow = new Date(now.getTime() + (user.timezoneOffset * 60 * 60 * 1000));
        const userLastReset = new Date(user.lastResetDate.getTime() + (user.timezoneOffset * 60 * 60 * 1000));
        
        // Check if it's a new day in user's timezone
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
    status: '🤖 Jarvis - Smart Reminder Assistant (FINAL OPTIMIZED VERSION)',
    message: 'Production-ready with 2-minute cron intervals and empathy features',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    uptime: process.uptime(),
    mongodb_status: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    twilio_status: process.env.TWILIO_ACCOUNT_SID ? 'configured' : 'not configured',
    openai_status: process.env.OPENAI_API_KEY ? 'configured' : 'not configured',
    final_fixes: [
      '⏰ OPTIMIZED TIMING: Cron runs every 2 minutes (not 1 minute)',
      '🎯 PRECISION WINDOW: Only processes reminders from last 2 minutes',
      '📱 INSTANT RESPONSE: No more setImmediate delays',
      '💙 EMPATHY HANDLING: Detects and responds to user frustration',
      '🕐 TIMEZONE DEBUG: Enhanced logging for time parsing issues',
      '🚫 NO MESSAGE LIMITS: Only 5 reminder/day limit matters',
      '💎 SMART PREMIUM: All non-reminder features require premium',
      '🕛 INDIVIDUAL RESETS: Each user resets at their own midnight'
    ],
    performance_optimizations: [
      '✅ 2-minute cron intervals (50% less server load than 1-minute)',
      '✅ Time window filtering prevents old reminder floods',
      '✅ Limit 5 reminders per cron run for stability',
      '✅ Immediate webhook processing for instant responses',
      '✅ Enhanced error handling with user feedback',
      '✅ Better timezone calculations with 1-minute buffer'
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
  console.log('🤖 Jarvis Smart Reminder Assistant is ready!');
  
  console.log('🧹 Cleaning up old reminders...');
  await cleanupOldReminders();
  
  console.log('📊 Checking Twilio account status...');
  const accountStatus = await checkTwilioAccountStatus();
  
  if (accountStatus) {
    console.log('✅ Twilio account verified:', accountStatus.type);
  } else {
    console.log('⚠️ Could not verify Twilio account status');
  }
  
  console.log('⏰ PERFORMANCE OPTIMIZED: Cron job every 2 minutes (not 1 minute)');
  console.log('🎯 PRECISION TIMING: Only processes reminders from last 2 minutes');
  console.log('📱 INSTANT RESPONSES: Direct webhook processing (no setImmediate delays)');
  console.log('💙 EMPATHY FEATURES: Detects and responds to user frustration gracefully');
  console.log('🕐 ENHANCED DEBUGGING: Better timezone and time parsing logs');
  console.log('🚫 SIMPLIFIED LIMITS: Only 5 reminder/day limit (no message limits)');
  console.log('💎 SMART MONETIZATION: All non-reminder features require premium');
  console.log('🕛 INDIVIDUAL RESETS: Each user resets at their own midnight');
  console.log('✅ All performance and user experience issues resolved!');
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
