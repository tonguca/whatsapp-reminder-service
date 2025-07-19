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

// Environment variables validation
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

// Enhanced User Schema
const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  userName: { type: String, required: true },
  preferredName: { type: String, default: null }, // How they want to be called
  personality: { type: String, default: null }, // calm, direct, cheerful
  timezone: { type: String, default: null },
  timezoneOffset: { type: Number, default: null },
  setupStage: { type: String, default: 'welcome' }, // welcome, name, personality, timezone, complete
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
  needsTimeConfirmation: { type: Boolean, default: false },
  isCompleted: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const Reminder = mongoose.model('Reminder', reminderSchema);

// Enhanced ChatGPT function
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
        max_tokens: 400,
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

// Enhanced reminder analysis with personality and recurring tasks
async function analyzeMessage(messageText, userName, personality = 'supportive') {
  const personalityPrompts = {
    calm: "You are a calm, gentle, and supportive assistant. Use soothing language and be very understanding.",
    direct: "You are direct, efficient, and to-the-point. Keep responses concise and focused on the task.",
    cheerful: "You are cheerful, funny, and energetic! Use emojis, jokes, and upbeat language to motivate users."
  };

  const systemMessage = `${personalityPrompts[personality] || personalityPrompts.calm}

Analyze this message to detect tasks, time references, and recurring patterns.

User's message: "${messageText}"

Understand natural short commands like:
- "mom check at 3pm" → task: "check on mom", time: "3pm"
- "vitamin morning" → task: "take vitamin", time: "morning" (suggest 8am)
- "call Ahmet in 2 hours" → task: "call Ahmet", time: "in 2 hours"
- "water plants weekly" → task: "water plants", recurring: "weekly"
- "meds every day 9am" → task: "take meds", time: "9am", recurring: "daily"

Respond with JSON only:
{
  "isTask": true/false,
  "task": "clean task description",
  "hasTime": true/false,
  "timeExpression": "extracted time",
  "isRecurring": true/false,
  "recurrencePattern": "daily/weekly/monthly" (if recurring),
  "suggestedTime": "suggested time if unclear",
  "needsTimeConfirmation": true/false,
  "motivationalMessage": "message matching your personality style",
  "clarificationQuestion": "question if time unclear"
}`;

  try {
    const result = await askChatGPT(messageText, systemMessage);
    return JSON.parse(result);
  } catch (error) {
    console.error('Error analyzing message:', error);
    const defaultResponses = {
      calm: "I'm here to help you stay organized peacefully. What would you like to remember? 🌸",
      direct: "Tell me what you need to remember and when. Format: 'task at time'",
      cheerful: "Hey there! 🎉 What awesome thing should I help you remember? Give me the details! ✨"
    };
    return { 
      isTask: false, 
      motivationalMessage: defaultResponses[personality] || defaultResponses.calm
    };
  }
}

// Enhanced timezone detection
async function detectTimezone(userInput) {
  const currentUTC = new Date().toISOString();
  const systemMessage = `Current UTC time: ${currentUTC}

User said: "${userInput}"

Calculate their timezone offset from UTC. Be smart about parsing time formats and locations.

Respond with JSON only:
{
  "timezoneOffset": number (hours from UTC, can be negative),
  "timezone": "readable timezone name",
  "confidence": "high/medium/low",
  "confirmation": "friendly confirmation message asking them to verify"
}

Examples:
- "It's 3:30 PM" → calculate offset based on UTC
- "Istanbul" → +3 hours from UTC
- "New York" → -5 hours (or -4 in daylight saving)`;

  try {
    const result = await askChatGPT(userInput, systemMessage);
    return JSON.parse(result);
  } catch (error) {
    console.error('Error detecting timezone:', error);
    return null;
  }
}

// Name extraction
async function extractPreferredName(userInput) {
  const systemMessage = `The user is telling me what they want to be called. Extract their preferred name.

User said: "${userInput}"

Respond with JSON only:
{
  "name": "extracted name",
  "confidence": "high/medium/low",
  "friendlyResponse": "warm response using their name"
}

Examples:
- "Call me John" → name: "John"
- "My name is Sarah" → name: "Sarah"  
- "Everyone calls me Mike" → name: "Mike"
- "Sarah" → name: "Sarah"`;

  try {
    const result = await askChatGPT(userInput, systemMessage);
    return JSON.parse(result);
  } catch (error) {
    console.error('Error extracting name:', error);
    return { name: userInput.trim(), friendlyResponse: `Nice to meet you, ${userInput.trim()}! 😊` };
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

// Context detection for emojis and encouragement
function detectContext(messageText) {
  const text = messageText.toLowerCase();
  
  const contexts = {
    family: {
      keywords: ['call mom', 'call dad', 'family', 'mother', 'father', 'sister', 'brother', 'mom', 'dad', 'parents'],
      emoji: '💕',
      encouragement: 'Family connections matter most! 💕',
      reminder: '👨‍👩‍👧‍👦 Time to connect with your loved ones!'
    },
    meeting: {
      keywords: ['meeting', 'conference', 'zoom', 'teams', 'call', 'appointment', 'interview'],
      emoji: '🤝',
      encouragement: 'You\'ve got this! 🤝',
      reminder: '💼 Time for your meeting!'
    },
    health: {
      keywords: ['doctor', 'dentist', 'clinic', 'hospital', 'medicine', 'medication', 'pills', 'checkup'],
      emoji: '🏥',
      encouragement: 'Your health is your wealth! 🏥',
      reminder: '⚕️ Time to take care of yourself!'
    },
    workout: {
      keywords: ['gym', 'workout', 'exercise', 'run', 'fitness', 'yoga', 'training', 'sport'],
      emoji: '💪',
      encouragement: 'Every workout counts! 💪',
      reminder: '🔥 Time to get moving!'
    },
    work: {
      keywords: ['deadline', 'project', 'task', 'work', 'email', 'report', 'presentation'],
      emoji: '⚡',
      encouragement: 'You\'re capable of amazing things! ⚡',
      reminder: '🎯 Time to get things done!'
    },
    shopping: {
      keywords: ['shopping', 'groceries', 'buy', 'store', 'market'],
      emoji: '🛒',
      encouragement: 'Smart planning ahead! 🛒',
      reminder: '🛍️ Shopping time!'
    }
  };
  
  for (const [contextName, contextData] of Object.entries(contexts)) {
    if (contextData.keywords.some(keyword => text.includes(keyword))) {
      return contextData;
    }
  }
  
  return {
    emoji: '⭐',
    encouragement: 'I\'ll help you stay on track! ⭐',
    reminder: '🔔 Here\'s your reminder!'
  };
}

// Enhanced reminder parsing with better time handling
async function parseReminderWithTimezone(messageText, user) {
  try {
    let parsed = chrono.parseDate(messageText);
    
    // If no specific time, try to detect relative time
    if (!parsed && messageText.toLowerCase().includes('tomorrow')) {
      // Default to 9 AM tomorrow if no time specified
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(9, 0, 0, 0);
      parsed = tomorrow;
    }
    
    if (!parsed) return null;
    
    // Convert to UTC for storage
    const utcTime = new Date(parsed.getTime() - (user.timezoneOffset * 60 * 60 * 1000));
    
    // Extract task
    const timeMatch = messageText.match(/\s+(at|on|in|tomorrow|today|next|tonight)\s+/i);
    let reminderText = messageText;
    
    if (timeMatch) {
      reminderText = messageText.substring(0, timeMatch.index).trim();
    }
    
    reminderText = reminderText.replace(/^(remind me to|reminder to|remind|remember to)\s+/i, '');
    
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

// Enhanced message handling with personalized onboarding
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
        setupStage: 'welcome'
      });
      await user.save();
    }

    // Handle onboarding stages
    if (user.setupStage === 'welcome') {
      await sendWhatsAppMessage(userId, `🌟 Hello there! Welcome to your personal AI reminder assistant! 🤖✨\n\nI'm excited to help you stay organized and never miss what matters most to you! 💝\n\n👋 What would you like me to call you? (Your name or nickname)`);
      user.setupStage = 'name';
      await user.save();
      return;
    }

    if (user.setupStage === 'name') {
      const nameInfo = await extractPreferredName(messageText);
      user.preferredName = nameInfo.name;
      user.setupStage = 'personality';
      await user.save();
      
      await sendWhatsAppMessage(userId, `${nameInfo.friendlyResponse}\n\n🎭 What style would you like for your assistant?\n\n1️⃣ **Calm and supportive** - Gentle and understanding\n2️⃣ **Direct and to the point** - Efficient and focused  \n3️⃣ **Cheerful and funny** - Energetic with humor\n\nJust reply with 1, 2, or 3! ✨`);
      return;
    }

    if (user.setupStage === 'personality') {
      let selectedPersonality = 'calm'; // default
      const choice = messageText.trim();
      
      if (choice === '1' || messageText.toLowerCase().includes('calm') || messageText.toLowerCase().includes('supportive')) {
        selectedPersonality = 'calm';
      } else if (choice === '2' || messageText.toLowerCase().includes('direct') || messageText.toLowerCase().includes('point')) {
        selectedPersonality = 'direct';
      } else if (choice === '3' || messageText.toLowerCase().includes('cheerful') || messageText.toLowerCase().includes('funny')) {
        selectedPersonality = 'cheerful';
      }
      
      user.personality = selectedPersonality;
      user.setupStage = 'timezone';
      await user.save();
      
      const personalityResponses = {
        calm: `Perfect choice, ${user.preferredName} 🌸 I'll be your calm and supportive companion.`,
        direct: `Got it, ${user.preferredName}. I'll keep things efficient and focused.`,
        cheerful: `Awesome choice, ${user.preferredName}! 🎉 This is going to be so much fun! ✨`
      };
      
      await sendWhatsAppMessage(userId, `${personalityResponses[selectedPersonality]}\n\n⏰ Now, what time is it where you are right now?\n\nJust tell me like "It's 3:30 PM" or your city like "Istanbul" 🌍`);
      return;
    }

    if (user.setupStage === 'timezone') {
      const timezoneInfo = await detectTimezone(messageText);
      if (timezoneInfo && timezoneInfo.confidence !== 'low') {
        user.timezoneOffset = timezoneInfo.timezoneOffset;
        user.timezone = timezoneInfo.timezone;
        user.setupStage = 'complete';
        await user.save();
        
        const personalityWelcomes = {
          calm: `${timezoneInfo.confirmation}\n\n🌸 Perfect! You're all set, ${user.preferredName}. I'm here to gently help you remember what matters.\n\nJust tell me naturally:\n• "vitamin morning"\n• "call mom at 6pm"\n• "water plants weekly"\n• "meds every day 9am"\n\nI understand you perfectly 💚`,
          direct: `${timezoneInfo.confirmation}\n\nSetup complete, ${user.preferredName}.\n\nCommands:\n• "task at time" - sets reminder\n• "task daily/weekly" - recurring\n• "list" - shows reminders\n\nReady.`,
          cheerful: `${timezoneInfo.confirmation}\n\n🎊 Woohoo! We're all set, ${user.preferredName}! This is so exciting! 🎉\n\nNow I can help you remember everything! Try these:\n• "gym tonight" 💪\n• "vitamin morning" 💊\n• "coffee with friends weekly" ☕\n\nLet's make your life amazing! ✨`
        };
        
        await sendWhatsAppMessage(userId, personalityWelcomes[user.personality] || personalityWelcomes.calm);
      } else {
        await sendWhatsAppMessage(userId, `I'm having trouble understanding your timezone, ${user.preferredName} 😅\n\nCould you try telling me:\n• Current time: "It's 2:30 PM"\n• Or your city: "London" or "Tokyo"\n\nThis helps me set perfect reminders for you! ⏰`);
      }
      return;
    }

    // Handle commands for completed setup
    if (messageText.toLowerCase().includes('list') || messageText.toLowerCase().includes('my reminders')) {
      const reminders = await Reminder.find({ 
        userId: userId, 
        isCompleted: false,
        scheduledTime: { $gt: new Date() }
      }).sort({ scheduledTime: 1 });
      
      if (reminders.length > 0) {
        let response = `📋 Your upcoming reminders, ${user.preferredName}:\n\n`;
        reminders.forEach((reminder, index) => {
          const context = detectContext(reminder.message);
          response += `${index + 1}. ${reminder.message} ${context.emoji}\n   📅 ${reminder.userLocalTime}\n\n`;
        });
        await sendWhatsAppMessage(userId, response);
      } else {
        await sendWhatsAppMessage(userId, `📋 No upcoming reminders, ${user.preferredName}!\n\n💡 Try telling me:\n• "gym tonight"\n• "call mom at 6pm"\n• "shopping tomorrow"`);
      }
      return;
    }

    // Smart message analysis
    const analysis = await analyzeMessage(messageText, user.preferredName, user.personality);
    
    if (analysis.isTask) {
      if (analysis.isRecurring) {
        // Handle recurring tasks
        await sendWhatsAppMessage(userId, `📅 I see you want to set up a recurring reminder!\n\n"${analysis.task}" - ${analysis.recurrencePattern}\n\n⚠️ Note: Currently I can set single reminders. For recurring tasks, I can remind you to set it up again each time! 🔄\n\nShould I create a one-time reminder for "${analysis.task}" now?`);
        return;
      }
      
      if (analysis.hasTime && !analysis.needsTimeConfirmation) {
        // Clear time given - create reminder
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
          const personalityConfirmations = {
            calm: `✅ ${analysis.motivationalMessage}\n\n🌸 Peaceful reminder set for ${reminderData.userLocalTime}:\n"${reminderData.message}" ${context.emoji}\n\nI'll gently remind you, ${user.preferredName} 💚`,
            direct: `✅ Reminder set: ${reminderData.userLocalTime}\n"${reminderData.message}" ${context.emoji}\n\nDone, ${user.preferredName}.`,
            cheerful: `✅ ${analysis.motivationalMessage}\n\n🎉 AWESOME! Reminder set for ${reminderData.userLocalTime}:\n"${reminderData.message}" ${context.emoji}\n\nI'm so excited to help you, ${user.preferredName}! 🌟`
          };
          
          await sendWhatsAppMessage(userId, personalityConfirmations[user.personality] || personalityConfirmations.calm);
        } else {
          await sendWhatsAppMessage(userId, `⚠️ I think that time has already passed, ${user.preferredName}!\n\n💡 Try: "${analysis.task} tomorrow at 9am" or "${analysis.task} at 6pm"`);
        }
      } else {
        // Task detected but needs time clarification
        const suggestion = analysis.suggestedTime ? `\n\n💡 Suggestion: "${analysis.task} ${analysis.suggestedTime}"` : '';
        await sendWhatsAppMessage(userId, `${analysis.clarificationQuestion || `Great! I see you want to remember "${analysis.task}" 📝\n\nWhen should I remind you?`}${suggestion}\n\nJust tell me like "at 7pm" or "tomorrow morning" ⏰`);
      }
    } else {
      // Not a task - general conversation
      const friendlyResponse = analysis.motivationalMessage || 
        `Hey ${user.preferredName}! 👋 I'm here to help you remember important things!\n\n💭 Just tell me naturally:\n• "gym at 7pm"\n• "call mom tomorrow" \n• "meeting at 2"\n• "buy groceries"\n\nWhat would you like to remember? ✨`;
      
      await sendWhatsAppMessage(userId, friendlyResponse);
    }
  } catch (error) {
    console.error('Error handling message:', error);
    try {
      await sendWhatsAppMessage(message.from, '❌ Sorry, something went wrong. Please try again! 🤖');
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
        const user = await User.findOne({ userId: reminder.userId });
        const preferredName = user?.preferredName || 'there';
        
        const context = detectContext(reminder.message);
        await sendWhatsAppMessage(
          reminder.userId,
          `${context.reminder}\n\n"${reminder.message}"\n\n💝 Hope this helps, ${preferredName}! From your AI assistant ✨`
        );
        
        reminder.isCompleted = true;
        await reminder.save();
        
        console.log(`Personalized reminder sent to ${preferredName}: ${reminder.message}`);
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
    status: '🌟 Smart Personal AI Reminder Assistant!',
    message: 'Ready to understand natural language and create personalized reminders',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    uptime: process.uptime(),
    mongodb_status: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    twilio_status: process.env.TWILIO_ACCOUNT_SID ? 'configured' : 'not configured',
    openai_status: process.env.OPENAI_API_KEY ? 'configured' : 'not configured',
    features: [
      '🌟 Warm personalized welcome experience',
      '👋 Custom name preferences',
      '🌍 Smart timezone detection',
      '🤖 Advanced natural language understanding',
      '💬 Conversational reminder creation',
      '⏰ Smart time suggestions and clarifications',
      '💝 Emotional intelligence and motivation',
      '📋 Personalized reminder management'
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
  console.log('🌟 Smart Personal AI Reminder Assistant is ready!');
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
