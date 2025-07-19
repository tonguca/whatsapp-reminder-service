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

// User Schema with reminder count
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

// Reminder Schema with recurring support
const reminderSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  userName: { type: String, required: true },
  message: { type: String, required: true },
  scheduledTime: { type: Date, required: true },
  userLocalTime: { type: String, required: true },
  isCompleted: { type: Boolean, default: false },
  isRecurring: { type: Boolean, default: false },
  recurrencePattern: { type: String, default: null },
  nextOccurrence: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
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
}`;

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

// Generate contextual motivational message for reminders
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
    
    // Handle specific Twilio errors gracefully
    if (error.response?.data) {
      const errorData = error.response.data;
      const errorCode = error.response.headers['x-twilio-error-code'];
      
      console.error('🚨 Twilio Error Details:', {
        code: errorCode,
        message: errorData.message,
        status: error.response.status
      });
      
      // Handle rate limiting specifically
      if (errorCode === '63038' || errorData.message?.includes('daily messages limit')) {
        console.error('🚫 RATE LIMIT: Twilio account daily message limit reached');
        return { success: false, error: 'rate_limited', code: '63038' };
      }
      
      // Handle other common Twilio errors
      if (errorCode === '21211') {
        console.error('📱 Invalid phone number format');
        return { success: false, error: 'invalid_phone', code: '21211' };
      }
      
      if (errorCode === '21614') {
        console.error('🚫 Phone number not verified (trial account)');
        return { success: false, error: 'unverified_number', code: '21614' };
      }
    }
    
    // For other errors, still return an error object instead of throwing
    return { success: false, error: 'unknown', message: error.message };
  }
}

// Enhanced reminder parsing
function parseReminderWithTimezone(messageText, task, timezoneOffset = 0) {
  try {
    let parsed = chrono.parseDate(messageText);
    
    if (!parsed) {
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

// Check Twilio account status on startup
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
      status: account.status,
      date_created: account.date_created
    });
    
    return account;
  } catch (error) {
    console.error('❌ Failed to check Twilio account status:', error.message);
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

// Enhanced webhook for receiving messages
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

// ENHANCED message handler with improved error handling
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
      const result = await sendWhatsAppMessage(userId, `🚫 Daily limit reached (${USAGE_LIMITS.FREE_TIER_MESSAGES} messages).\n\n⭐ Upgrade for unlimited reminders!`);
      
      if (!result.success) {
        console.log('🚫 Cannot send rate limit message - API error:', result.error);
      }
      return;
    }

    user.messageCount += 1;
    await user.save();

    // Setup flow with error handling
    if (!user.isSetup) {
      if (!user.preferredName) {
        const result = await sendWhatsAppMessage(userId, `🤖 Hi! I'm Jarvis, your reminder assistant.\n\n📋 I help you remember things with SPECIFIC times:\n\n✅ "gym at 7pm today"\n✅ "call mom at 3pm tomorrow"\n❌ "gym tonight" (too vague)\n❌ "call mom tomorrow" (no time)\n\nWhat should I call you?`);
        
        if (!result.success) {
          console.log('🚫 Cannot send setup message - API error:', result.error);
          return;
        }
        
        const cleanName = messageText.replace(/[^a-zA-Z\s]/g, '').trim();
        if (cleanName && cleanName.length > 0 && cleanName.length < 20) {
          user.preferredName = cleanName;
          await user.save();
          
          const result2 = await sendWhatsAppMessage(userId, `Got it, ${cleanName}!\n\nWhat's your location? (e.g., "Istanbul", "New York")\n\nThis helps me set accurate reminder times.`);
          
          if (!result2.success) {
            console.log('🚫 Cannot send location request - API error:', result2.error);
          }
        }
        return;
      }
      
      if (!user.location) {
        const timezoneInfo = await detectLocationTimezone(messageText);
        if (timezoneInfo) {
          user.location = timezoneInfo.location;
          user.timezoneOffset = timezoneInfo.timezoneOffset;
          user.isSetup = true;
          await user.save();
          
          const result = await sendWhatsAppMessage(userId, `${timezoneInfo.confirmation}\n\n✅ Setup complete, ${user.preferredName}!\n\n📋 How to set reminders:\n• "gym at 7pm today"\n• "call mom at 3pm tomorrow"\n• "meeting Monday at 2pm"\n\n⚠️ Always include specific day and time\n\nCommands: "list reminders", "change name to X"\n\nReady! 🎯`);
          
          if (!result.success) {
            console.log('🚫 Cannot send setup complete message - API error:', result.error);
          }
        } else {
          const result = await sendWhatsAppMessage(userId, `Please specify your location clearly:\n\n• "Istanbul"\n• "New York"\n• "London"\n\nThis helps me set accurate times.`);
          
          if (!result.success) {
            console.log('🚫 Cannot send location clarification - API error:', result.error);
          }
        }
        return;
      }
    }

    // Handle pending reminder confirmations
    if (user.pendingReminder && (messageText.toLowerCase() === 'yes' || messageText.toLowerCase() === 'y')) {
      const usageCheck = await checkUsageLimits(user);
      if (!usageCheck.withinReminderLimit) {
        user.pendingReminder = null;
        await user.save();
        
        const result = await sendWhatsAppMessage(userId, `💙 Hey ${user.preferredName}, you've reached your daily limit of ${USAGE_LIMITS.FREE_TIER_REMINDERS} reminders!\n\nI love helping you stay organized! 😊\n\n✨ **Upgrade to unlimited** and I can help you remember everything that matters!`);
        
        if (!result.success) {
          console.log('🚫 Cannot send reminder limit message - API error:', result.error);
        }
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
      
      user.reminderCount += 1;
      user.pendingReminder = null;
      await user.save();
      
      const recurringText = pendingData.isRecurring ? ` (${pendingData.recurrencePattern})` : '';
      const remainingReminders = USAGE_LIMITS.FREE_TIER_REMINDERS - user.reminderCount;
      const limitWarning = remainingReminders <= 2 ? `\n\n💫 ${remainingReminders} reminders left today` : '';
      
      const result = await sendWhatsAppMessage(userId, `✅ ${pendingData.isRecurring ? 'Recurring reminder' : 'Reminder'} confirmed!\n\n"${pendingData.message}"${recurringText}\n📅 ${pendingData.userLocalTime}\n\nAll set, ${user.preferredName}! 🎯${limitWarning}`);
      
      if (!result.success) {
        console.log('🚫 Cannot send confirmation message - API error:', result.error);
      }
      return;
    }
    
    if (user.pendingReminder && (messageText.toLowerCase() === 'no' || messageText.toLowerCase() === 'n')) {
      user.pendingReminder = null;
      await user.save();
      
      const result = await sendWhatsAppMessage(userId, `❌ Reminder cancelled, ${user.preferredName}.\n\nTry again when ready! 🎯`);
      
      if (!result.success) {
        console.log('🚫 Cannot send cancellation message - API error:', result.error);
      }
      return;
    }
    
    // Name change check
    const nameChange = isNameChange(messageText);
    if (nameChange) {
      user.preferredName = nameChange;
      await user.save();
      
      const result = await sendWhatsAppMessage(userId, `✅ Updated! I'll call you ${nameChange}.`);
      
      if (!result.success) {
        console.log('🚫 Cannot send name change confirmation - API error:', result.error);
      }
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
        
        const result = await sendWhatsAppMessage(userId, response);
        
        if (!result.success) {
          console.log('🚫 Cannot send reminders list - API error:', result.error);
        }
      } else {
        const result = await sendWhatsAppMessage(userId, `📋 No reminders set, ${user.preferredName}.\n\nTry: "gym at 7pm today"`);
        
        if (!result.success) {
          console.log('🚫 Cannot send no reminders message - API error:', result.error);
        }
      }
      return;
    }
    
    // Reminder analysis
    const analysis = await analyzeReminder(messageText, user.preferredName);
    
    if (analysis && analysis.isReminder) {
      if (analysis.isRecurring) {
        if (analysis.timeFound) {
          const reminderData = parseReminderWithTimezone(messageText, analysis.task, user.timezoneOffset);
          
          if (reminderData && reminderData.scheduledTime > new Date()) {
            const dayName = new Date(reminderData.scheduledTime.getTime() + (user.timezoneOffset * 60 * 60 * 1000)).toLocaleDateString('en-US', { weekday: 'long' });
            
            const result = await sendWhatsAppMessage(userId, `🔄 Recurring reminder:\n\n"${analysis.task}" - ${analysis.recurrencePattern}\n📅 Starting: ${dayName}, ${reminderData.userLocalTime}\n\nReply "yes" to confirm recurring reminder.`);
            
            if (result.success) {
              user.pendingReminder = {
                message: analysis.task,
                scheduledTime: reminderData.scheduledTime,
                userLocalTime: reminderData.userLocalTime,
                isRecurring: true,
                recurrencePattern: analysis.recurrencePattern
              };
              await user.save();
            } else {
              console.log('🚫 Cannot send recurring reminder confirmation - API error:', result.error);
            }
          } else {
            const result = await sendWhatsAppMessage(userId, `⚠️ That time has passed. Try: "${analysis.task} ${analysis.recurrencePattern} starting tomorrow at 9am"`);
            
            if (!result.success) {
              console.log('🚫 Cannot send time passed message - API error:', result.error);
            }
          }
        } else {
          const result = await sendWhatsAppMessage(userId, `🔄 Recurring task: "${analysis.task}" - ${analysis.recurrencePattern}\n\nWhat time should this repeat?\n\n• "at 8am daily"\n• "Mondays at 2pm"\n• "every Sunday at 10am"`);
          
          if (!result.success) {
            console.log('🚫 Cannot send recurring time request - API error:', result.error);
          }
        }
        return;
      }
      
      if (analysis.timeFound && !analysis.needsTime) {
        const reminderData = parseReminderWithTimezone(messageText, analysis.task, user.timezoneOffset);
        
        if (reminderData && reminderData.scheduledTime > new Date()) {
          let confirmationMsg = `📝 Confirm reminder:\n\n"${reminderData.message}"`;
          if (analysis.typosCorrected && analysis.originalTask) {
            confirmationMsg = `📝 Confirm reminder (I corrected "${analysis.originalTask}" → "${analysis.task}"):\n\n"${reminderData.message}"`;
          }
          
          const dayName = new Date(reminderData.scheduledTime.getTime() + (user.timezoneOffset * 60 * 60 * 1000)).toLocaleDateString('en-US', { weekday: 'long' });
          
          const result = await sendWhatsAppMessage(userId, `${confirmationMsg}\n📅 ${dayName}, ${reminderData.userLocalTime}\n\nReply "yes" to confirm or "no" to cancel.`);
          
          if (result.success) {
            user.pendingReminder = {
              message: reminderData.message,
              scheduledTime: reminderData.scheduledTime,
              userLocalTime: reminderData.userLocalTime
            };
            await user.save();
          } else {
            console.log('🚫 Cannot send reminder confirmation - API error:', result.error);
          }
        } else {
          const result = await sendWhatsAppMessage(userId, `⚠️ That time has passed, ${user.preferredName}.\n\nTry: "${analysis.task} tomorrow at 9am"`);
          
          if (!result.success) {
            console.log('🚫 Cannot send time passed message - API error:', result.error);
          }
        }
      } else if (analysis.clarificationNeeded) {
        const result = await sendWhatsAppMessage(userId, `🤔 I think you mean "${analysis.task}" but I'm not sure.\n\nDid you mean:\n• "${analysis.task} at [time]"?\n\nPlease clarify with specific day and time.`);
        
        if (!result.success) {
          console.log('🚫 Cannot send clarification request - API error:', result.error);
        }
      } else {
        const result = await sendWhatsAppMessage(userId, `📝 Task: "${analysis.task}"\n\n⚠️ Please specify exact day and time:\n\n• "at 7pm today"\n• "at 3pm tomorrow"\n• "Monday at 2pm"\n\nBe specific to avoid confusion.`);
        
        if (!result.success) {
          console.log('🚫 Cannot send time specification request - API error:', result.error);
        }
      }
      return;
    }
    
    // General help
    const remainingMsgs = usageCheck.remainingMessages;
    let warningText = remainingMsgs <= 10 ? `\n\n⚠️ ${remainingMsgs} messages left today` : '';
    
    const result = await sendWhatsAppMessage(userId, `Hi ${user.preferredName}! 🤖\n\n📋 Set reminders with specific times:\n\n• "gym at 7pm today"\n• "call mom at 3pm tomorrow"\n• "meeting Monday at 2pm"\n\n⚠️ Always include day and exact time\n\nCommands: "list reminders"${warningText}`);
    
    if (!result.success) {
      console.log('🚫 Cannot send help message - API error:', result.error);
    }
    
  } catch (error) {
    console.error('❌ Handler error:', error);
    try {
      const result = await sendWhatsAppMessage(message.from, '❌ Something went wrong. Please try again.');
      if (!result.success) {
        console.log('🚫 Cannot send error message - API error:', result.error);
      }
    } catch (sendError) {
      console.error('❌ Error message send failed:', sendError);
    }
  }
}

// Enhanced cron job for reminders with error handling
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
        
        const contextualMsg = await generateContextualMessage(reminder.message, preferredName);
        
        const recurringIcon = reminder.isRecurring ? '🔄' : '🔔';
        const result = await sendWhatsAppMessage(
          reminder.userId,
          `${recurringIcon} REMINDER: "${reminder.message}"\n\n💪 ${contextualMsg.encouragement}\n\n🌟 ${contextualMsg.reward}\n\nGo for it, ${preferredName}!`
        );
        
        if (result.success) {
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
        } else {
          console.log(`❌ Failed to send reminder to ${preferredName}: ${result.error}`);
          // Don't mark as completed if sending failed - will retry next minute
        }
      } catch (error) {
        console.error(`❌ Reminder error for ${reminder.userId}:`, error);
      }
    }
  } catch (error) {
    console.error('❌ Cron error:', error);
  }
});

// Enhanced health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: '🤖 Jarvis - Smart Reminder Assistant (Production Ready)',
    message: 'Direct, efficient, AI-powered reminders with robust error handling',
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
      '🛡️ Robust error handling for Twilio rate limits',
      '⚡ Production-ready with graceful failures',
      '🚫 Usage limits with upgrade prompts'
    ],
    improvements: [
      '✅ Enhanced Twilio error handling',
      '✅ Graceful API failure recovery',
      '✅ Detailed logging for debugging',
      '✅ Account status monitoring',
      '✅ No app crashes on rate limits',
      '✅ Improved webhook reliability'
    ]
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// Enhanced server startup
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log('🤖 Jarvis Smart Reminder Assistant is ready!');
  
  // Check Twilio account status on startup
  console.log('📊 Checking Twilio account status...');
  await checkTwilioAccountStatus();
  
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
