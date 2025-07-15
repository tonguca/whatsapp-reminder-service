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

// Environment variables validation
const requiredEnvVars = {
  VERIFY_TOKEN: process.env.VERIFY_TOKEN,
  WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN,
  PHONE_NUMBER_ID: process.env.PHONE_NUMBER_ID,
  MONGODB_URI: process.env.MONGODB_URI
};

// Check for missing environment variables
const missingVars = Object.entries(requiredEnvVars)
  .filter(([key, value]) => !value)
  .map(([key]) => key);

if (missingVars.length > 0) {
  console.error('Missing required environment variables:', missingVars);
  console.error('Please set these variables in your Render dashboard');
  process.exit(1);
}

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('Connected to MongoDB'))
.catch(err => {
  console.error('MongoDB connection error:', err);
  process.exit(1);
});

// Reminder Schema
const reminderSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  userName: { type: String, required: true },
  message: { type: String, required: true },
  scheduledTime: { type: Date, required: true },
  isCompleted: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const Reminder = mongoose.model('Reminder', reminderSchema);

// WhatsApp API functions
async function sendWhatsAppMessage(to, message) {
  try {
    const response = await axios.post(
      `https://graph.facebook.com/v17.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to,
        text: { body: message },
        type: 'text'
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );
    console.log('Message sent successfully:', response.data);
    return response.data;
  } catch (error) {
    console.error('Error sending WhatsApp message:', error.response?.data || error.message);
    throw error;
  }
}

// Context detection for human touches
function detectContext(messageText) {
  const text = messageText.toLowerCase();
  
  const contexts = {
    family: {
      keywords: ['call mom', 'call dad', 'call family', 'call mother', 'call father', 'call sister', 'call brother', 'family call', 'parents'],
      emoji: '💕',
      encouragement: 'Family time is precious! 💕',
      reminder: '👨‍👩‍👧‍👦 Don\'t forget to call your loved ones!'
    },
    meeting: {
      keywords: ['meeting', 'conference', 'zoom', 'teams', 'work call', 'presentation', 'interview'],
      emoji: '🤝',
      encouragement: 'You\'ve got this! Good luck with your meeting! 🤝',
      reminder: '💼 Time for your meeting! Go show them what you\'re made of!'
    },
    health: {
      keywords: ['doctor', 'appointment', 'dentist', 'clinic', 'hospital', 'checkup', 'medical'],
      emoji: '🏥',
      encouragement: 'Taking care of your health is so important! 🏥',
      reminder: '⚕️ Health comes first! Time for your appointment!'
    },
    workout: {
      keywords: ['gym', 'workout', 'exercise', 'run', 'jog', 'fitness', 'yoga', 'training'],
      emoji: '💪',
      encouragement: 'Your future self will thank you! 💪',
      reminder: '🔥 Time to get moving! Your body will love you for this!'
    },
    celebration: {
      keywords: ['birthday', 'anniversary', 'party', 'celebration', 'congratulate'],
      emoji: '🎉',
      encouragement: 'Celebrations make life beautiful! 🎉',
      reminder: '🎂 Time to celebrate! Don\'t miss this special moment!'
    },
    medication: {
      keywords: ['medicine', 'pills', 'medication', 'tablets', 'dose'],
      emoji: '💊',
      encouragement: 'Staying healthy is the best investment! 💊',
      reminder: '⏰ Time for your medicine! Your health matters!'
    },
    food: {
      keywords: ['eat', 'lunch', 'dinner', 'breakfast', 'meal', 'food'],
      emoji: '🍽️',
      encouragement: 'Nourishing your body is an act of self-love! 🍽️',
      reminder: '🥗 Time to fuel your amazing body!'
    },
    work: {
      keywords: ['deadline', 'project', 'task', 'work', 'submit', 'finish'],
      emoji: '⚡',
      encouragement: 'You\'re capable of amazing things! ⚡',
      reminder: '🎯 Time to tackle that task! You\'ve got this!'
    }
  };
  
  for (const [contextName, contextData] of Object.entries(contexts)) {
    if (contextData.keywords.some(keyword => text.includes(keyword))) {
      return contextData;
    }
  }
  
  return {
    emoji: '⭐',
    encouragement: 'I\'ll make sure you don\'t forget! ⭐',
    reminder: '🔔 Here\'s your friendly reminder!'
  };
}

// Parse reminder from message
function parseReminder(messageText) {
  const parsed = chrono.parseDate(messageText);
  if (!parsed) return null;
  
  // Extract the reminder message (everything before the time phrase)
  const timeMatch = messageText.match(/\s+(at|on|in|tomorrow|today|next)\s+/i);
  let reminderText = messageText;
  
  if (timeMatch) {
    reminderText = messageText.substring(0, timeMatch.index).trim();
  }
  
  const context = detectContext(messageText);
  
  return {
    message: reminderText || 'Reminder',
    scheduledTime: parsed,
    context: context
  };
}

// Webhook verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
      console.log('Webhook verified successfully');
      res.status(200).send(challenge);
    } else {
      console.error('Webhook verification failed');
      res.sendStatus(403);
    }
  } else {
    res.sendStatus(400);
  }
});

// Webhook for receiving messages
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    console.log('Received webhook:', JSON.stringify(body, null, 2));

    if (body.object === 'whatsapp_business_account') {
      body.entry?.forEach(entry => {
        entry.changes?.forEach(change => {
          if (change.field === 'messages') {
            const messages = change.value.messages;
            const contacts = change.value.contacts;
            
            if (messages && messages.length > 0) {
              messages.forEach(async (message) => {
                if (message.type === 'text') {
                  const contact = contacts?.find(c => c.wa_id === message.from);
                  await handleIncomingMessage(message, contact);
                }
              });
            }
          }
        });
      });
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.sendStatus(500);
  }
});

// Handle incoming messages
async function handleIncomingMessage(message, contact) {
  try {
    const userId = message.from;
    const userName = contact?.profile?.name || 'User';
    const messageText = message.text.body.toLowerCase();

    console.log(`Processing message from ${userName} (${userId}): ${messageText}`);

    if (messageText.includes('remind me') || messageText.includes('reminder')) {
      const reminderData = parseReminder(messageText);
      
      if (reminderData && reminderData.scheduledTime > new Date()) {
        // Save reminder to database
        const reminder = new Reminder({
          userId: userId,
          userName: userName,
          message: reminderData.message,
          scheduledTime: reminderData.scheduledTime
        });
        
        await reminder.save();
        
        const context = reminderData.context;
        const confirmationMessage = `✅ ${context.encouragement}\n\nReminder set for ${reminderData.scheduledTime.toLocaleString()}:\n"${reminderData.message}" ${context.emoji}`;
        await sendWhatsAppMessage(userId, confirmationMessage);
      } else {
        await sendWhatsAppMessage(userId, '❌ Sorry, I couldn\'t understand the time. Please try again with a format like "Remind me to call John at 3 PM tomorrow"');
      }
    } else if (messageText.includes('list') || messageText.includes('my reminders')) {
      const reminders = await Reminder.find({ 
        userId: userId, 
        isCompleted: false,
        scheduledTime: { $gt: new Date() }
      }).sort({ scheduledTime: 1 });
      
      if (reminders.length > 0) {
        let response = '📋 Your upcoming reminders:\n\n';
        reminders.forEach((reminder, index) => {
          const context = detectContext(reminder.message);
          response += `${index + 1}. ${reminder.message} ${context.emoji}\n   📅 ${reminder.scheduledTime.toLocaleString()}\n\n`;
        });
        await sendWhatsAppMessage(userId, response);
      } else {
        await sendWhatsAppMessage(userId, '📋 You have no upcoming reminders.\n\n💡 Try saying "Remind me to call mom at 6 PM" or "Remind me about my doctor appointment tomorrow at 2 PM"');
      }
    } else {
      await sendWhatsAppMessage(userId, `👋 Hi ${userName}! I'm your caring reminder assistant! 💝\n\nI can help you remember important things with a personal touch:\n\n💕 "Remind me to call mom at 6 PM"\n🤝 "Remind me about my meeting tomorrow at 2 PM"\n🏥 "Remind me about my doctor appointment Friday at 10 AM"\n💪 "Remind me to go to the gym at 7 AM"\n🎉 "Remind me about Sarah's birthday party Saturday"\n\nTry "list my reminders" to see what's coming up! ✨`);
    }
  } catch (error) {
    console.error('Error handling message:', error);
    await sendWhatsAppMessage(message.from, '❌ Sorry, something went wrong. Please try again.');
  }
}

// Cron job to check for due reminders
cron.schedule('* * * * *', async () => {
  try {
    const now = new Date();
    const dueReminders = await Reminder.find({
      scheduledTime: { $lte: now },
      isCompleted: false
    });

    for (const reminder of dueReminders) {
      const context = detectContext(reminder.message);
      await sendWhatsAppMessage(
        reminder.userId,
        `${context.reminder}\n\n"${reminder.message}"\n\nSent with care 💙`
      );
      
      reminder.isCompleted = true;
      await reminder.save();
      
      console.log(`Caring reminder sent to ${reminder.userName}: ${reminder.message}`);
    }
  } catch (error) {
    console.error('Error checking reminders:', error);
  }
});

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: '💝 WhatsApp Caring Reminder Bot is running!',
    message: 'Ready to help you remember what matters most',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    features: [
      '💕 Family call reminders',
      '🤝 Meeting support',
      '🏥 Health appointment care',
      '💪 Fitness motivation',
      '🎉 Celebration alerts',
      '💊 Medication reminders'
    ]
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('WhatsApp Reminder Bot is ready!');
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  await mongoose.connection.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...');
  await mongoose.connection.close();
  process.exit(0);
});
