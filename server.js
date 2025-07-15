require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const cron = require('node-cron');

const app = express();
app.use(express.urlencoded({ extended: true }));

// Twilio setup
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// In-memory storage
let reminders = [];
let userProfiles = {};

// Motivational messages
const motivationalMessages = {
  meeting: ["🤝 Good luck with your meeting! You've got this!", "💼 Time for your meeting! Go show them what you're made of!"],
  call: ["📞 Time to make that call! They'll be happy to hear from you!", "☎️ Call time! You're great at staying connected!"],
  family: ["👨‍👩‍👧‍👦 Family time! These moments are precious!", "❤️ Time to connect with family! Love is everything!"],
  dentist: ["🦷 Dentist time! Hope it goes smoothly and painlessly!", "🦷 Dental appointment! Taking care of your health is awesome!"],
  doctor: ["🏥 Doctor appointment time. Hope everything goes well!", "👩‍⚕️ Medical appointment! You're doing great taking care of yourself!"],
  medicine: ["💊 Medicine reminder! Taking care of yourself is important!", "💊 Time for your medicine! Your health matters!"],
  workout: ["💪 Workout time! You're crushing your fitness goals!", "🏋️ Exercise time! Your body will thank you!"],
  work: ["💼 Work reminder! You're doing amazing things!", "📋 Task time! You've got this handled!"],
  birthday: ["🎂 Birthday reminder! Make someone's day special!", "🎉 It's party time! Birthdays are magical!"],
  default: ["🔔 Reminder time! You've got this!", "⏰ Time for your reminder! Hope your day is going great!"]
};

// Parse reminder from message
function parseReminder(message) {
  const text = message.toLowerCase().trim();
  
  let task = '';
  const remindPatterns = [
    /remind me (?:to )?(.+?) (?:at|tomorrow|in \d+|on)/i,
    /remind me (?:to )?(.+)/i
  ];
  
  for (const pattern of remindPatterns) {
    const match = text.match(pattern);
    if (match) {
      task = match[1].trim();
      break;
    }
  }
  
  const timePatterns = [
    /(?:at )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i,
    /(?:at )?(\d{1,2})(?::(\d{2}))?/i
  ];
  
  let timeMatch = null;
  for (const pattern of timePatterns) {
    const match = text.match(pattern);
    if (match) {
      timeMatch = match;
      break;
    }
  }
  
  let targetDate = new Date();
  if (text.includes('tomorrow')) {
    targetDate.setDate(targetDate.getDate() + 1);
  } else if (text.includes('in 2 days')) {
    targetDate.setDate(targetDate.getDate() + 2);
  } else if (text.includes('in 3 days')) {
    targetDate.setDate(targetDate.getDate() + 3);
  }
  
  return { task, timeMatch, targetDate };
}

// Get motivational message
function getMotivationalMessage(task) {
  const lowerTask = task.toLowerCase();
  
  if (lowerTask.includes('meeting')) return motivationalMessages.meeting[Math.floor(Math.random() * motivationalMessages.meeting.length)];
  if (lowerTask.includes('mom') || lowerTask.includes('dad') || lowerTask.includes('family')) return motivationalMessages.family[Math.floor(Math.random() * motivationalMessages.family.length)];
  if (lowerTask.includes('call')) return motivationalMessages.call[Math.floor(Math.random() * motivationalMessages.call.length)];
  if (lowerTask.includes('dentist')) return motivationalMessages.dentist[Math.floor(Math.random() * motivationalMessages.dentist.length)];
  if (lowerTask.includes('doctor')) return motivationalMessages.doctor[Math.floor(Math.random() * motivationalMessages.doctor.length)];
  if (lowerTask.includes('medicine')) return motivationalMessages.medicine[Math.floor(Math.random() * motivationalMessages.medicine.length)];
  if (lowerTask.includes('workout') || lowerTask.includes('gym')) return motivationalMessages.workout[Math.floor(Math.random() * motivationalMessages.workout.length)];
  if (lowerTask.includes('work')) return motivationalMessages.work[Math.floor(Math.random() * motivationalMessages.work.length)];
  if (lowerTask.includes('birthday')) return motivationalMessages.birthday[Math.floor(Math.random() * motivationalMessages.birthday.length)];
  
  return motivationalMessages.default[Math.floor(Math.random() * motivationalMessages.default.length)];
}

// Send message
function sendMessage(to, body) {
  if (!process.env.TWILIO_ACCOUNT_SID || process.env.TWILIO_ACCOUNT_SID === 'your_account_sid_here') {
    console.log(`Would send to ${to}: ${body}`);
    return;
  }
  
  client.messages
    .create({
      from: process.env.TWILIO_WHATSAPP_NUMBER,
      to: to,
      body: body
    })
    .then(message => console.log(`Sent: ${message.sid}`))
    .catch(err => console.error('Error:', err));
}

// Complete reminder
function completeReminder(from, ampm) {
  const profile = userProfiles[from];
  if (!profile) return;
  
  scheduleReminder(from, profile.task, profile.targetDate, profile.hour, profile.minute, ampm);
  delete userProfiles[from];
}

// Schedule reminder
function scheduleReminder(from, task, targetDate, hour, minute, ampm) {
  let hour24 = hour;
  if (ampm && ampm.toLowerCase() === 'pm' && hour !== 12) hour24 += 12;
  if (ampm && ampm.toLowerCase() === 'am' && hour === 12) hour24 = 0;
  
  targetDate.setHours(hour24, minute || 0, 0, 0);
  
  if (targetDate <= new Date()) {
    sendMessage(from, "⚠️ That time has already passed! Please set a future time.");
    return;
  }
  
  const earlyDate = new Date(targetDate.getTime() - 30 * 60000);
  
  const reminder = {
    id: Date.now() + Math.random(),
    from: from,
    task: task,
    scheduledTime: targetDate,
    earlyTime: earlyDate,
    completed: false,
    earlySent: false
  };
  
  reminders.push(reminder);
  
  const dateStr = targetDate.toLocaleDateString('en-US', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });
  const timeStr = targetDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
  
  const confirmMessage = `✅ Perfect! Reminder set:
📝 Task: ${task}
📅 Date: ${dateStr}
⏰ Time: ${timeStr}

🔔 I'll give you a heads up 30 minutes early and remind you again at the exact time!

${getMotivationalMessage(task)}`;

  sendMessage(from, confirmMessage);
}

// WhatsApp webhook
app.post('/webhook', (req, res) => {
  const message = req.body.Body || '';
  const from = req.body.From || '';
  
  console.log(`Received: "${message}" from ${from}`);
  
  if (userProfiles[from] && userProfiles[from].waitingForAmPm) {
    const choice = message.trim().toLowerCase();
    if (choice === '1' || choice.includes('am')) {
      completeReminder(from, 'AM');
    } else if (choice === '2' || choice.includes('pm')) {
      completeReminder(from, 'PM');
    } else {
      sendMessage(from, "Please choose:\n1️⃣ AM\n2️⃣ PM");
    }
    res.status(200).send();
    return;
  }
  
  if (message.toLowerCase().includes('remind me')) {
    const parsed = parseReminder(message);
    
    if (!parsed.task) {
      sendMessage(from, "I'd love to help! Please tell me what to remind you about. Try:\n'Remind me to call mom tomorrow at 6pm'");
    } else if (parsed.timeMatch) {
      const hour = parseInt(parsed.timeMatch[1]);
      const minute = parsed.timeMatch[2] ? parseInt(parsed.timeMatch[2]) : 0;
      const ampm = parsed.timeMatch[3];
      
      if (!ampm && hour >= 1 && hour <= 12) {
        userProfiles[from] = {
          waitingForAmPm: true,
          task: parsed.task,
          hour: hour,
          minute: minute,
          targetDate: parsed.targetDate
        };
        
        const timeStr = `${hour}:${minute.toString().padStart(2, '0')}`;
        sendMessage(from, `📅 Got it! Is ${timeStr} in the morning or evening?\n\n1️⃣ AM (morning)\n2️⃣ PM (evening)`);
      } else {
        scheduleReminder(from, parsed.task, parsed.targetDate, hour, minute, ampm);
      }
    } else {
      sendMessage(from, `I'd love to remind you about "${parsed.task}"! \n\nPlease include a time like:\n'Remind me to ${parsed.task} tomorrow at 6pm'`);
    }
  } else if (message.toLowerCase().includes('help')) {
    sendMessage(from, `👋 Hi! I'm your personal reminder assistant! 

Here's how I work:
- Say "Remind me to [task] at [time]"
- I'll send you motivational reminders
- 30 minutes early + right on time

Examples:
📞 "Remind me to call mom tomorrow at 6pm"
🦷 "Remind me dentist appointment at 2pm"
💼 "Remind me meeting with John at 9am"

Try it now! 😊`);
  } else {
    sendMessage(from, `👋 Welcome to your Personal Reminder Assistant!

I'm here to help you remember important things with a motivational touch! 

Try saying:
"Remind me to call mom tomorrow at 6pm"

I'll send you encouraging reminders 30 minutes early and right on time! 

What would you like me to remind you about? 😊`);
  }
  
  res.status(200).send();
});

// Check reminders every minute
cron.schedule('* * * * *', () => {
  const now = new Date();
  console.log(`Checking reminders at ${now.toLocaleTimeString()}...`);
  
  reminders.forEach((reminder) => {
    if (!reminder.completed) {
      if (!reminder.earlySent && now >= reminder.earlyTime) {
        const timeStr = reminder.scheduledTime.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        const earlyMessage = `⚠️ 30-minute heads up!
📝 ${reminder.task}
⏰ Scheduled for ${timeStr}

Getting ready? I'll remind you again right on time! 😊`;
        
        sendMessage(reminder.from, earlyMessage);
        reminder.earlySent = true;
      }
      
      if (now >= reminder.scheduledTime) {
        const finalMessage = `🔔 It's time!
📝 ${reminder.task}

${getMotivationalMessage(reminder.task)}`;
        
        sendMessage(reminder.from, finalMessage);
        reminder.completed = true;
      }
    }
  });
});

// Health check
app.get('/', (req, res) => {
  const activeReminders = reminders.filter(r => !r.completed).length;
  
  res.send(`
    <h1>🤖 WhatsApp Reminder Bot</h1>
    <p>Status: <strong>Running</strong> ✅</p>
    <p>Active Reminders: <strong>${activeReminders}</strong></p>
    <p>Server Time: <strong>${new Date().toLocaleString()}</strong></p>
    <hr>
    <p>Ready to help you remember everything! 😊</p>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 WhatsApp Reminder Bot running on port ${PORT}`);
});
