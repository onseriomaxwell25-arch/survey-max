// =============================================
// MAXI SURVEYS - BACKEND SERVER
// Node.js + Express + JSON file storage
// =============================================
// Setup: npm install express cors uuid bcryptjs body-parser
// Run:   node server.js
// =============================================

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = 5000;
const DB_PATH = './db';

// ---- MIDDLEWARE ----
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('.'));

// ---- DB HELPERS ----
// Simple JSON file-based database (no external DB needed)
function ensureDB(){
  if(!fs.existsSync(DB_PATH)) fs.mkdirSync(DB_PATH, {recursive:true});
  const files = ['users','deposits','withdrawals','notifications','transactions','referrals','answers'];
  files.forEach(f=>{
    const fp = path.join(DB_PATH, f+'.json');
    if(!fs.existsSync(fp)) fs.writeFileSync(fp, '[]');
  });
}

function readDB(name){
  try {
    return JSON.parse(fs.readFileSync(path.join(DB_PATH, name+'.json'), 'utf8'));
  } catch(e){ return []; }
}

function writeDB(name, data){
  fs.writeFileSync(path.join(DB_PATH, name+'.json'), JSON.stringify(data, null, 2));
}

function findById(name, id){
  return readDB(name).find(x=>x.id===id)||null;
}

function updateRecord(name, id, updates){
  const data = readDB(name);
  const idx = data.findIndex(x=>x.id===id);
  if(idx !== -1){
    data[idx] = {...data[idx], ...updates};
    writeDB(name, data);
    return data[idx];
  }
  return null;
}

ensureDB();

// ---- ADMIN ACCOUNT ----
// Create admin if not exists
(function createAdmin(){
  const users = readDB('users');
  if(!users.find(u=>u.role==='admin')){
    users.push({
      id: 'admin',
      name: 'Maxwell Admin',
      email: 'maxwellonserio@gmail.com',
      username: 'admin_Maxi@2007',
      password: bcrypt.hashSync('2007', 10),
      role: 'admin',
      status: 'active',
      package: 'vip',
      balance: 0,
      totalEarned: 0,
      referralCode: 'ADMIN',
      referrals: [],
      unlockedPackages: {standard:true,premium:true,vip:true,extra:true},
      createdAt: new Date().toISOString(),
      dailyProgress: {},
      weeklyData: []
    });
    writeDB('users', users);
    console.log('✅ Admin account created: admin_Maxi@2007 / 2007');
  }
})();

// =============================================
// AUTH ROUTES
// =============================================

// POST /api/auth/signup
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, username, email, password, refCode } = req.body;
    if(!name||!username||!email||!password){
      return res.json({success:false, message:'All fields are required'});
    }

    const users = readDB('users');
    if(users.find(u=>u.email===email)){
      return res.json({success:false, message:'Email already registered'});
    }
    if(users.find(u=>u.username===username)){
      return res.json({success:false, message:'Username already taken'});
    }

    const hashedPw = await bcrypt.hash(password, 10);
    const newUser = {
      id: uuidv4(),
      name, username, email,
      password: hashedPw,
      role: 'user',
      status: 'pending', // Awaiting admin approval
      package: 'standard',
      balance: 0,
      totalEarned: 0,
      referralCode: uuidv4().slice(0,8).toUpperCase(),
      referrals: [],
      referredBy: refCode||null,
      unlockedPackages: {standard:true,premium:false,vip:false,extra:false},
      createdAt: new Date().toISOString(),
      dailyProgress: {},
      weeklyData: [],
      streak: 0
    };

    users.push(newUser);
    writeDB('users', users);

    // Track referral
    if(refCode){
      const refUser = users.find(u=>u.id===refCode);
      if(refUser){
        if(!refUser.referrals) refUser.referrals = [];
        refUser.referrals.push({userId:newUser.id, status:'pending', date:new Date().toISOString()});
        updateRecord('users', refUser.id, {referrals:refUser.referrals});
      }
    }

    // Notify admin
    addSystemNotification('admin', `📋 New Signup: ${name} (${username}) is awaiting verification.`, 'admin');

    const {password:_, ...safeUser} = newUser;
    res.json({success:true, message:'Account created! Awaiting admin verification.', user:safeUser});
  } catch(e){
    console.error(e);
    res.json({success:false, message:'Server error'});
  }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const users = readDB('users');
    const user = users.find(u=>u.username===username||u.email===username);

    if(!user) return res.json({success:false, message:'User not found'});

    // Admin shortcut
    if(user.role==='admin' && (password==='2007'||await bcrypt.compare(password, user.password))){
      const {password:_, ...safeUser} = user;
      return res.json({success:true, user:safeUser});
    }

    const valid = await bcrypt.compare(password, user.password);
    if(!valid) return res.json({success:false, message:'Wrong password'});

    if(user.status==='pending') return res.json({success:false, message:'Account pending admin verification'});
    if(user.status==='rejected') return res.json({success:false, message:'Account rejected by admin'});

    const {password:_, ...safeUser} = user;
    res.json({success:true, user:safeUser});
  } catch(e){
    res.json({success:false, message:'Login error'});
  }
});

// =============================================
// USER ROUTES
// =============================================

// GET /api/user/:id
app.get('/api/user/:id', (req, res) => {
  const user = findById('users', req.params.id);
  if(!user) return res.json({success:false, message:'User not found'});

  const txns = readDB('transactions').filter(t=>t.userId===req.params.id);
  const answers = readDB('answers').filter(a=>a.userId===req.params.id);

  // Today's answers
  const today = new Date().toDateString();
  const answeredToday = {};
  answers.filter(a=>new Date(a.date).toDateString()===today).forEach(a=>{
    answeredToday[a.questionId] = a.optionIdx;
  });

  const todayEarned = answers
    .filter(a=>new Date(a.date).toDateString()===today && a.correct)
    .length * 5;

  // Referral stats
  const allUsers = readDB('users');
  const verifiedRefs = (user.referrals||[]).filter(r=>r.status==='verified').length;
  const totalRefs = (user.referrals||[]).length;
  const refEarned = Math.floor(verifiedRefs/5) * 20;

  const {password:_, ...safeUser} = user;
  res.json({
    success: true,
    user: safeUser,
    transactions: txns.slice(0,20),
    answeredToday,
    dailyProgress: Object.keys(answeredToday).length,
    todayEarned,
    unlockedPackages: user.unlockedPackages||{standard:true,premium:false,vip:false,extra:false},
    weeklyData: user.weeklyData||[],
    referrals: {total:totalRefs, verified:verifiedRefs, earned:refEarned}
  });
});

// =============================================
// SURVEY ROUTES
// =============================================

// POST /api/survey/answer
app.post('/api/survey/answer', (req, res) => {
  const { userId, questionId, correct, earned } = req.body;
  const answers = readDB('answers');

  answers.push({
    id: uuidv4(),
    userId, questionId, correct,
    earned: earned||0,
    optionIdx: req.body.optionIdx||0,
    date: new Date().toISOString()
  });
  writeDB('answers', answers);

  if(correct && earned > 0){
    const user = findById('users', userId);
    if(user){
      updateRecord('users', userId, {
        balance: (user.balance||0) + earned,
        totalEarned: (user.totalEarned||0) + earned
      });
      // Add transaction
      const txns = readDB('transactions');
      txns.push({
        id: uuidv4(),
        userId, type:'survey_earning', amount:earned,
        status:'completed', date:new Date().toISOString()
      });
      writeDB('transactions', txns);
    }
  }

  // Update weekly data
  updateWeeklyData(userId);
  res.json({success:true});
});

function updateWeeklyData(userId){
  const user = findById('users', userId);
  if(!user) return;

  const weeklyData = user.weeklyData||[];
  const today = new Date().toDateString();
  const dayLabel = new Date().toLocaleDateString('en-GB',{weekday:'short'});

  const answers = readDB('answers');
  const todayAnswers = answers.filter(a=>a.userId===userId && new Date(a.date).toDateString()===today);
  const todayEarned = todayAnswers.filter(a=>a.correct).length * 5;

  const existIdx = weeklyData.findIndex(w=>w.date===today);
  const entry = {label:dayLabel, date:today, surveys:todayAnswers.length, earnings:todayEarned};

  if(existIdx !== -1) weeklyData[existIdx] = entry;
  else weeklyData.push(entry);

  // Keep last 7 weeks (49 days)
  const trimmed = weeklyData.slice(-49);
  updateRecord('users', userId, {weeklyData:trimmed});
}

// =============================================
// PAYMENT ROUTES
// =============================================

// POST /api/payment/deposit
app.post('/api/payment/deposit', (req, res) => {
  const { userId, amount, mpesaMessage } = req.body;
  if(!userId||!amount||!mpesaMessage){
    return res.json({success:false, message:'Missing fields'});
  }

  // Validate: must contain "Confirmed" and "0742022424"
  const isValid = /confirmed/i.test(mpesaMessage) && /0742022424/i.test(mpesaMessage);
  if(!isValid){
    return res.json({success:false, message:'Invalid M-Pesa message. Must be a real Send Money confirmation to 0742022424.'});
  }

  const user = findById('users', userId);
  const deposits = readDB('deposits');

  const dep = {
    id: uuidv4(),
    userId,
    userName: user?.name||'Unknown',
    amount: parseFloat(amount),
    mpesaMessage,
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  deposits.push(dep);
  writeDB('deposits', deposits);

  // Notify admin
  addSystemNotification('admin', `💳 Deposit Request: ${user?.name} sent Ksh ${amount}. Message: "${mpesaMessage.slice(0,60)}..."`, 'admin');

  res.json({success:true, message:'Deposit submitted for admin verification!'});
});

// POST /api/payment/withdraw
app.post('/api/payment/withdraw', (req, res) => {
  const { userId, phone, amount } = req.body;
  const user = findById('users', userId);
  if(!user) return res.json({success:false, message:'User not found'});
  if((user.balance||0) < amount) return res.json({success:false, message:'Insufficient balance'});
  if(amount < 50) return res.json({success:false, message:'Minimum withdrawal is Ksh 50'});

  const withdrawals = readDB('withdrawals');
  const wid = {
    id: uuidv4(),
    userId,
    userName: user.name,
    phone, amount: parseFloat(amount),
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  withdrawals.push(wid);
  writeDB('withdrawals', withdrawals);

  // Deduct balance temporarily
  updateRecord('users', userId, {balance: (user.balance||0) - amount});

  // Notify admin
  addSystemNotification('admin', `💸 Withdrawal Request: ${user.name} wants Ksh ${amount} to ${phone}`, 'admin');

  // Add transaction
  const txns = readDB('transactions');
  txns.push({id:uuidv4(),userId,type:'withdrawal',amount,phone,status:'pending',date:new Date().toISOString()});
  writeDB('transactions', txns);

  res.json({success:true, message:'Withdrawal request submitted!'});
});

// POST /api/payment/verify (package unlock)
app.post('/api/payment/verify', (req, res) => {
  const { userId, type, package: pkg, amount, mpesaMessage } = req.body;
  const isValid = /confirmed/i.test(mpesaMessage) && /0742022424/i.test(mpesaMessage);
  if(!isValid) return res.json({success:false, message:'Invalid M-Pesa message'});

  const user = findById('users', userId);
  const deposits = readDB('deposits');
  deposits.push({
    id: uuidv4(),
    userId, userName:user?.name,
    amount, mpesaMessage,
    type: type||'package_unlock',
    package: pkg,
    status: 'pending',
    createdAt: new Date().toISOString()
  });
  writeDB('deposits', deposits);

  addSystemNotification('admin', `📦 Package Unlock: ${user?.name} paid Ksh ${amount} for ${pkg} package. Verify M-Pesa message.`, 'admin');
  res.json({success:true, message:'Payment submitted for verification!'});
});

// =============================================
// NOTIFICATION ROUTES
// =============================================

// GET /api/notifications/:userId
app.get('/api/notifications/:userId', (req, res) => {
  const notifs = readDB('notifications').filter(n=>n.targetUserId===req.params.userId||n.targetUserId==='all');
  res.json({success:true, notifications:notifs.slice(0,50)});
});

function addSystemNotification(targetUserId, body, type='info', title=''){
  const notifs = readDB('notifications');
  notifs.unshift({
    id: uuidv4(),
    targetUserId, title: title||body.slice(0,50),
    body, type,
    read: false,
    time: new Date().toLocaleTimeString(),
    createdAt: new Date().toISOString()
  });
  writeDB('notifications', notifs.slice(0,1000));
}

// =============================================
// ADMIN ROUTES
// =============================================

function isAdmin(req, res, next){
  // Simple header-based auth (frontend sends user id)
  const userId = req.headers['x-user-id'];
  if(userId === 'admin' || findById('users', userId)?.role === 'admin') return next();
  res.status(403).json({success:false, message:'Admin access required'});
}

// GET /api/admin/users
app.get('/api/admin/users', (req, res) => {
  const users = readDB('users').map(({password:_, ...u})=>u);
  res.json({success:true, users});
});

// POST /api/admin/users/:id/approve
app.post('/api/admin/users/:id/approve', (req, res) => {
  const user = updateRecord('users', req.params.id, {status:'active'});
  if(!user) return res.json({success:false, message:'User not found'});

  // Notify user they're approved
  addSystemNotification(req.params.id, '🎉 Your account has been verified! You can now login and start earning.', 'admin', '✅ Account Approved');

  // Process referral reward
  if(user.referredBy){
    const refUsers = readDB('users');
    const refUser = refUsers.find(u=>u.id===user.referredBy);
    if(refUser){
      const refs = refUser.referrals||[];
      const idx = refs.findIndex(r=>r.userId===user.id);
      if(idx!==-1) refs[idx].status = 'verified';

      // Check 5-referral milestone
      const verifiedCount = refs.filter(r=>r.status==='verified').length;
      if(verifiedCount > 0 && verifiedCount % 5 === 0){
        const reward = 20;
        updateRecord('users', refUser.id, {
          balance: (refUser.balance||0)+reward,
          totalEarned: (refUser.totalEarned||0)+reward,
          referrals: refs
        });
        const txns = readDB('transactions');
        txns.push({id:uuidv4(),userId:refUser.id,type:'referral_bonus',amount:reward,status:'completed',date:new Date().toISOString()});
        writeDB('transactions', txns);
        addSystemNotification(refUser.id, `🎉 You earned Ksh 20 for 5 verified referrals!`, 'money', '💰 Referral Bonus!');
      } else {
        updateRecord('users', refUser.id, {referrals:refs});
      }
    }
  }

  res.json({success:true, message:'User approved'});
});

// POST /api/admin/users/:id/reject
app.post('/api/admin/users/:id/reject', (req, res) => {
  updateRecord('users', req.params.id, {status:'rejected'});
  addSystemNotification(req.params.id, '❌ Your account verification was rejected. Contact admin for more info.', 'admin', 'Account Rejected');
  res.json({success:true});
});

// GET /api/admin/deposits
app.get('/api/admin/deposits', (req, res) => {
  const deps = readDB('deposits');
  res.json({success:true, deposits:deps.reverse()});
});

// POST /api/admin/deposits/:id/approve
app.post('/api/admin/deposits/:id/approve', (req, res) => {
  const dep = findById('deposits', req.params.id);
  if(!dep) return res.json({success:false, message:'Not found'});
  if(dep.status!=='pending') return res.json({success:false, message:'Already processed'});

  updateRecord('deposits', req.params.id, {status:'approved', approvedAt:new Date().toISOString()});

  // Credit user wallet
  const user = findById('users', dep.userId);
  if(user){
    updateRecord('users', dep.userId, {balance:(user.balance||0)+dep.amount});
    const txns = readDB('transactions');
    txns.push({id:uuidv4(),userId:dep.userId,type:'deposit',amount:dep.amount,status:'completed',date:new Date().toISOString()});
    writeDB('transactions', txns);
  }

  // Handle package unlock if type matches
  if(dep.type==='package_unlock' && dep.package){
    const u = findById('users', dep.userId);
    if(u){
      const unlocked = u.unlockedPackages||{standard:true};
      unlocked[dep.package] = true;
      updateRecord('users', dep.userId, {package:dep.package, unlockedPackages:unlocked});
    }
    addSystemNotification(dep.userId, `🎉 Your ${dep.package} package has been unlocked! You can now access more questions.`, 'money', `✅ ${dep.package.toUpperCase()} Unlocked!`);
  } else {
    addSystemNotification(dep.userId, `💰 Your deposit of Ksh ${dep.amount} has been approved and added to your wallet!`, 'money', '✅ Deposit Approved');
  }

  res.json({success:true});
});

// POST /api/admin/deposits/:id/reject
app.post('/api/admin/deposits/:id/reject', (req, res) => {
  updateRecord('deposits', req.params.id, {status:'rejected', rejectedAt:new Date().toISOString()});
  const dep = findById('deposits', req.params.id);
  if(dep) addSystemNotification(dep.userId, `❌ Your deposit of Ksh ${dep.amount} was rejected. Invalid M-Pesa message.`, 'admin', 'Deposit Rejected');
  res.json({success:true});
});

// GET /api/admin/withdrawals
app.get('/api/admin/withdrawals', (req, res) => {
  const withs = readDB('withdrawals');
  res.json({success:true, withdrawals:withs.reverse()});
});

// POST /api/admin/withdrawals/:id/approve
app.post('/api/admin/withdrawals/:id/approve', (req, res) => {
  updateRecord('withdrawals', req.params.id, {status:'approved', processedAt:new Date().toISOString()});
  const w = findById('withdrawals', req.params.id);
  if(w){
    updateRecord('transactions', null, null); // just log
    addSystemNotification(w.userId, `💸 Your withdrawal of Ksh ${w.amount} to ${w.phone} has been processed!`, 'money', '✅ Withdrawal Paid');
  }
  res.json({success:true});
});

// POST /api/admin/withdrawals/:id/reject
app.post('/api/admin/withdrawals/:id/reject', (req, res) => {
  const w = findById('withdrawals', req.params.id);
  if(w){
    updateRecord('withdrawals', req.params.id, {status:'rejected'});
    // Refund balance
    const user = findById('users', w.userId);
    if(user) updateRecord('users', w.userId, {balance:(user.balance||0)+w.amount});
    addSystemNotification(w.userId, `❌ Withdrawal of Ksh ${w.amount} was rejected. Amount refunded to wallet.`, 'admin', 'Withdrawal Rejected');
  }
  res.json({success:true});
});

// POST /api/admin/notify — send message to specific user
app.post('/api/admin/notify', (req, res) => {
  const { targetUserId, title, body } = req.body;
  if(!targetUserId||!body) return res.json({success:false, message:'Missing fields'});
  addSystemNotification(targetUserId, body, 'admin', title||'Admin Message');
  res.json({success:true});
});

// POST /api/admin/broadcast — send to all or specific user
app.post('/api/admin/broadcast', (req, res) => {
  const { target, title, message } = req.body;
  if(target==='all'){
    addSystemNotification('all', message, 'admin', title);
  } else {
    addSystemNotification(target, message, 'admin', title);
  }
  res.json({success:true});
});

// =============================================
// HEALTH CHECK
// =============================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'Maxi Surveys Backend',
    version: '1.0.0',
    time: new Date().toISOString(),
    db: 'JSON file storage',
    admin: 'maxwellonserio@gmail.com',
    mpesa: '0742022424'
  });
});

// =============================================
// START SERVER
// =============================================
app.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║      💎 MAXI SURVEYS BACKEND           ║');
  console.log('╠════════════════════════════════════════╣');
  console.log(`║  Server running on port ${PORT}           ║`);
  console.log('║  Admin: admin_Maxi@2007 / 2007         ║');
  console.log('║  M-Pesa number: 0742022424             ║');
  console.log('║  API: http://localhost:5000/api        ║');
  console.log('╚════════════════════════════════════════╝\n');
});

module.exports = app;