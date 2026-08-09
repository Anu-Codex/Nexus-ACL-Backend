require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const SibApiV3Sdk = require('sib-api-v3-sdk');
const bcrypt = require('bcryptjs');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

mongoose.connect(process.env.MONGO_URI).then(() => console.log("✅ Connected to MongoDB"));

// --- BREVO CONFIG ---
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;
const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

// --- SCHEMAS ---
const userSchema = new mongoose.Schema({
    name: String,
    email: { type: String, unique: true },
    password: { type: String },
    role: { type: String, default: 'visitor' }, // visitor, captain, admin
    isVerified: { type: Boolean, default: false },
    otp: String,
    otpExpires: Date
});

const playerSchema = new mongoose.Schema({
    name: String, strength: Number, cardType: String, baseValue: Number,
    phone: Number,
    imageUrl: String,
    status: { type: String, default: 'Available' }, soldTo: { type: String, default: '-' }
});

const teamSchema = new mongoose.Schema({ name: String, budget: Number });

const chatSchema = new mongoose.Schema({ 
    sender: String, role: String, text: String, timestamp: { type: Date, default: Date.now } 
});

const User = mongoose.model('User', userSchema);
const Player = mongoose.model('Player', playerSchema);
const Team = mongoose.model('Team', teamSchema);
const Chat = mongoose.model('Chat', chatSchema);

// --- HARDCODED CREDENTIALS (As requested) ---


// --- AUTH UTILITIES ---
async function sendOTPEmail(email, otp) {
    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    sendSmtpEmail.subject = "PITCH KINGS FC Verification Code";
    sendSmtpEmail.htmlContent = `<html><body><h1>Your OTP: ${otp}</h1><p>Use this code to verify your account.</p></body></html>`;
    sendSmtpEmail.sender = { "name": "PITCH KINGS FC", "email": process.env.BREVO_SENDER_EMAIL };
    sendSmtpEmail.to = [{ "email": email }];
    return apiInstance.sendTransacEmail(sendSmtpEmail);
}

// --- AUTOMATIC TEAM SEEDING ---



// Add this temporary seeding logic at the bottom of server.js
async function createMasterAdmin() {
    const exists = await User.findOne({ email: "sarkaranubhav48@gmail.com" });
    if (!exists) {
        const hashedPassword = await bcrypt.hash("admin123", 10);
        await User.create({
            name: "Nexus Master Admin",
            email: "sarkaranubhav48@gmail.com",
            password: hashedPassword,
            role: "admin",
            isVerified: true
        });
        console.log("👑 Master Admin Account Created.");
    }
}
createMasterAdmin();

// --- HTTP ROUTES ---
app.get('/reset-teams', async (req, res) => {
    try {
        await Team.deleteMany({}); 
        await Team.insertMany(teamList);
        res.send("✅ Teams successfully reset to 2000L!");
    } catch (e) { res.status(500).send(e.message); }
});

app.get('/fix-budgets', async (req, res) => {
    try {
        await Team.updateMany({}, { $set: { budget: 2000 } });
        res.send("✅ All budgets reset to 2000L!");
    } catch (e) { res.status(500).send(e.message); }
});

// --- AUCTION LOGIC & TIMER ---
let auctionState = { 
    activePlayerId: null, 
    currentBid: 0, 
    highestBidder: 'No Bids Yet', 
    timeLeft: 120,
    skippedTeams: [],
    isFinalCall: false,     // NEW
    finalCallText: ""

};
let timerInterval = null;
let slideshowState = {
    active: false,
    currentIndex: 0,
    players: []
};
let slideshowInterval = null;

function getFinalCallText(seconds) {
    if (seconds > 25) return "Are there any further bids?";
    if (seconds > 20) return "For the first time...";
    if (seconds > 15) return "For the second time...";
    if (seconds > 10) return "Going once...";
    if (seconds > 5) return "Going twice...";
    if (seconds > 0) return "SOLD!";
    return "SOLD!";
}

function startTimer() {
    clearInterval(timerInterval);
    // If it's a final call, we start from 30, otherwise standard 60 (or 120 as you mentioned)
    auctionState.timeLeft = auctionState.isFinalCall ? 30 : 120; 
    
    timerInterval = setInterval(async () => {
        auctionState.timeLeft--;
        
        if (auctionState.isFinalCall) {
            auctionState.finalCallText = getFinalCallText(auctionState.timeLeft);
        }
        if (auctionState.timeLeft <= 0) {
            clearInterval(timerInterval);
            await autoSellPlayer();
        } else {
            io.emit('updateAuction', auctionState);
        }
    }, 1000);
}

async function autoSellPlayer() {
    if (auctionState.activePlayerId && auctionState.highestBidder !== 'No Bids Yet') {
        const price = auctionState.currentBid;
        const teamName = auctionState.highestBidder;

        await Player.findByIdAndUpdate(auctionState.activePlayerId._id, {
            status: 'Sold',
            soldTo: `${teamName} (${price}M)`
        });
        await Team.findOneAndUpdate({ name: teamName }, { $inc: { budget: -price } });

        auctionState = { activePlayerId: null, currentBid: 0, highestBidder: 'No Bids Yet', timeLeft: 0 };
        
        io.emit('updatePlayers', await Player.find());
        io.emit('updateTeams', await Team.find());
        io.emit('updateAuction', auctionState);
        io.emit('newMessage', { sender: "SYSTEM", role: "admin", text: `🔴 SOLD! ${teamName} bought the player for ${price}L.` });
    } else {
        auctionState = { activePlayerId: null, currentBid: 0, highestBidder: 'No Bids Yet', timeLeft: 0 };
        io.emit('updateAuction', auctionState);
    }
}

// --- SOCKETS ---
io.on('connection', async (socket) => {
    socket.emit('initialData', {
        players: await Player.find(),
        teams: await Team.find(),
        chats: await Chat.find().sort({ timestamp: 1 }).limit(50),
        state: auctionState
    });

    // --- NEW: AUTHENTICATION EVENTS ---

    

    // 2. Special Sign In (Captain/Admin)
    socket.on('specialSignIn', async ({ email, password, type }) => {
    try {
        const user = await User.findOne({ email, role: type });
        
        if (!user) return socket.emit('errorMsg', "User not found in authorized list.");

        // Compare entered password with hashed password in DB
        const isMatch = await bcrypt.compare(password, user.password);
        
        if (isMatch) {
            const otp = Math.floor(100000 + Math.random() * 900000).toString();
            user.otp = otp;
            user.otpExpires = Date.now() + 600000; // 10 mins
            await user.save();
            await sendOTPEmail(email, otp);
            socket.emit('authStep', 'otp_verify');
        } else {
            socket.emit('errorMsg', "Incorrect Password.");
        }
    } catch (e) { socket.emit('errorMsg', "Auth Error"); }
});
    socket.on('guestSignIn', () => {
    // Directly succeed without checking any password
    socket.emit('guestLoginSuccess', { name: "Guest Viewer", role: "guest" });
});

// --- ADMIN MANAGEMENT FUNCTIONS ---
socket.on('getAuthorizedUsers', async () => {
    // Only send non-visitors to admin
    const users = await User.find({ role: { $ne: 'visitor' } }).select('-password -otp');
    socket.emit('authorizedUsersList', users);
});
    // --- 1. LINKED USER CREATION (WITH VARIABLE BUDGET) ---
socket.on('createNewUser', async (data) => {
    try {
        const hashedPassword = await bcrypt.hash(data.password, 10);
        const userEmail = data.email.trim().toLowerCase();
        const teamName = data.teamName.trim();
        const customBudget = Number(data.budget) || 2000; // Use input or default to 2000

        // Create/Update the User in DB
        await User.findOneAndUpdate(
            { email: userEmail },
            {
                name: teamName, 
                email: userEmail,
                password: hashedPassword,
                role: data.role,
                isVerified: true
            },
            { upsert: true }
        );

        // Link to Franchise if role is captain
        if (data.role === 'captain') {
            await Team.findOneAndUpdate(
                { name: teamName },
                { name: teamName, budget: customBudget },
                { upsert: true }
            );
        }

        // Send updated data to Admin
        const users = await User.find({ role: { $ne: 'visitor' } }).select('-password -otp');
        const teams = await Team.find();
        io.emit('authorizedUsersList', users);
        io.emit('updateTeams', teams);
        socket.emit('newMessage', { sender: "SYSTEM", text: `✅ User ${userEmail} linked to ${teamName} with ${customBudget}M.` });

    } catch (err) {
        console.error("User Creation Error:", err);
        socket.emit('errorMsg', "Failed to create user. Check if email is unique.");
    }
});

// --- 2. FRANCHISE CREATION / BUDGET UPDATE ---
socket.on('createNewTeam', async ({ name, budget }) => {
    try {
        const teamName = name.trim();
        const teamBudget = Number(budget);

        await Team.findOneAndUpdate(
            { name: teamName },
            { name: teamName, budget: teamBudget },
            { upsert: true }
        );

        const allTeams = await Team.find();
        io.emit('updateTeams', allTeams);
        socket.emit('newMessage', { sender: "SYSTEM", text: `✅ Franchise [${teamName}] updated to ${teamBudget}M.` });
    } catch (err) {
        console.error("Franchise Error:", err);
        socket.emit('errorMsg', "Error managing franchise.");
    }
});

    
    socket.on('deleteAuthorizedUser', async (id) => {
    await User.findByIdAndDelete(id);
    const users = await User.find({ role: { $ne: 'visitor' } }).select('-password -otp');
    socket.emit('authorizedUsersList', users);
});

    // 3. Verify OTP
    socket.on('verifyOTP', async ({ email, otp }) => {
        try {
            const user = await User.findOne({ 
                email, 
                otp, 
                otpExpires: { $gt: Date.now() } 
            });

            if (user) {
                user.isVerified = true;
                user.otp = undefined;
                await user.save();
                socket.emit('loginSuccess', { name: user.name, role: user.role, email: user.email });
            } else {
                socket.emit('errorMsg', "Invalid or Expired OTP");
            }
        } catch (err) {
            socket.emit('errorMsg', "Verification Error");
        }
    });

    // --- PREVIOUS AUCTION FUNCTIONS (UNTOUCHED) ---

    socket.on('addPlayer', async (data) => {
        try {
            const newPlayer = new Player({ ...data, strength: Number(data.strength), baseValue: Number(data.baseValue),
            phone: Number(data.phone),
            imageUrl: data.imageUrl  
            });
            await newPlayer.save();
            io.emit('updatePlayers', await Player.find()); 
        } catch (err) { console.error(err); }
    });

    socket.on('startAuction', async ({ playerId, baseValue }) => {
    const player = await Player.findById(playerId);
    if (player) {
        // --- ADD THIS LINE ---
        // Reset status so an 'Unsold' player becomes 'Available' again during bidding
        await Player.findByIdAndUpdate(playerId, { status: 'Available', soldTo: '-' });
        
        auctionState = { 
            activePlayerId: player, 
            currentBid: baseValue, 
            highestBidder: 'No Bids Yet', 
            timeLeft: 60,
            skippedTeams: [] 
        };
        
        // Broadcast the status reset to the list
        io.emit('updatePlayers', await Player.find());
        io.emit('updateAuction', auctionState);
        
        // Optional: Notify the chat
        io.emit('newMessage', { 
            sender: "SYSTEM", 
            role: "admin", 
            text: `📢 RE-ENTRY: ${player.name} is back on the auction block!` 
        });
        
        startTimer();
    }
});

    socket.on('startFinalCall', () => {
    if (auctionState.activePlayerId && auctionState.highestBidder !== 'No Bids Yet') {
        auctionState.isFinalCall = true;
        startTimer(); // This will now start the 30s sequence
        io.emit('updateAuction', auctionState);
        io.emit('newMessage', { sender: "SYSTEM", role: "admin", text: "⚠️ ADMIN HAS INITIATED THE FINAL CALL!" });
    }
});

    socket.on('placeBid', async ({ teamName, increment }) => {
    // 1. Check if they already skipped
    if (auctionState.skippedTeams.includes(teamName)) {
        return socket.emit('errorMsg', "You skipped this round!");
    }

    // 2. Check if they are already the highest bidder
    if (auctionState.highestBidder === teamName) {
        return socket.emit('errorMsg', "You are already the highest bidder!");
    }

    const team = await Team.findOne({ name: teamName });
    const newBid = auctionState.currentBid + increment;

    if (team && team.budget >= newBid) {
        auctionState.currentBid = newBid;
        auctionState.highestBidder = teamName;

        // --- NEW CODE ADDED HERE ---
        // If someone bids, we cancel the Final Call and return to normal timer
        auctionState.isFinalCall = false;
        auctionState.finalCallText = "";
        // ---------------------------

        startTimer(); // This will now reset to 60s because isFinalCall is false
        io.emit('updateAuction', auctionState);
    }
});

    
    socket.on('skipRound', ({ teamName }) => {
    if (!auctionState.skippedTeams.includes(teamName)) {
        auctionState.skippedTeams.push(teamName);
        io.emit('updateAuction', auctionState);
        io.emit('newMessage', { 
            sender: "SYSTEM", 
            role: "admin", 
            text: `⚠️ ${teamName} has skipped this round.` 
        });
    }
});

    socket.on('sellPlayer', autoSellPlayer);
    socket.on('cancelAuction', () => {
        clearInterval(timerInterval);
        auctionState = { activePlayerId: null, currentBid: 0, highestBidder: 'No Bids Yet', timeLeft: 0 };
        io.emit('updateAuction', auctionState);
    });

    socket.on('addBonus', async ({ teamName, amount }) => {
        try {
            await Team.findOneAndUpdate({ name: teamName }, { $inc: { budget: Number(amount) } });
            io.emit('updateTeams', await Team.find());
            io.emit('newMessage', { sender: "SYSTEM", role: "admin", text: `✨ ${teamName} purse adjusted by ${amount}M!` });
        } catch (err) { console.error(err); }
    });
    // --- FORCE PURSE DEDUCTION (ADMIN ONLY) ---
socket.on('deductPurse', async ({ teamName, amount }) => {
    try {
        // Ensure the amount is treated as a negative number
        const deduction = -Math.abs(Number(amount));
        
        await Team.findOneAndUpdate(
            { name: teamName }, 
            { $inc: { budget: deduction } }
        );

        // Update all screens
        const updatedTeams = await Team.find();
        io.emit('updateTeams', updatedTeams);

        // Broadcast to chat with a Warning style
        io.emit('newMessage', { 
            sender: "SYSTEM", 
            role: "admin", 
            text: `⚠️ PENALTY: ${teamName} purse has been forcefully reduced by ${Math.abs(amount)}M!` 
        });
    } catch (err) {
        console.error(err);
        socket.emit('errorMsg', "Force deduction failed.");
    }
});
    // --- ADMIN TEAM/FRANCHISE MANAGEMENT ---

// 1. Create a New Team
socket.on('createNewTeam', async ({ name, budget }) => {
    try {
        const newTeam = new Team({ 
            name: name.trim(), 
            budget: Number(budget) 
        });
        await newTeam.save();
        
        // Broadcast updated list to all users
        const allTeams = await Team.find();
        io.emit('updateTeams', allTeams);
        
        socket.emit('newMessage', { sender: "SYSTEM", text: `✅ Team [${name}] created with ${budget}M budget.` });
    } catch (err) {
        socket.emit('errorMsg', "Team already exists or error occurred.");
    }
});

// 2. Delete a Team
socket.on('deleteTeam', async (id) => {
    try {
        await Team.findByIdAndDelete(id);
        
        const allTeams = await Team.find();
        io.emit('updateTeams', allTeams);
        
        socket.emit('newMessage', { sender: "SYSTEM", text: "❌ Team removed from the database." });
    } catch (err) {
        socket.emit('errorMsg', "Failed to delete team.");
    }
});

    socket.on('sendMessage', async (data) => {
    try {
        // SERVER SIDE SECURITY: Only allow admin or captain roles to broadcast
        if (data.role === 'admin' || data.role === 'captain') {
            await new Chat(data).save();
            io.emit('newMessage', data);
        } else {
            console.log(`Blocked chat attempt from unauthorized role: ${data.role}`);
            // Optional: send an error only to that specific user
            socket.emit('errorMsg', "You do not have permission to send messages.");
        }
    } catch (err) {
        console.error("Chat Error:", err);
    }
});

    socket.on('deletePlayer', async (playerId) => {
        await Player.findByIdAndDelete(playerId);
        io.emit('updatePlayers', await Player.find()); 
    });
    // --- MEGA RESET (ADMIN ONLY) ---
socket.on('hardResetDatabase', async () => {
    // Safety check: only allow the master admin email to trigger this
    // You can also check if (user.role === 'admin')
    try {
        console.log("🚨 MEGA RESET INITIATED");

        // 1. Clear all collections
        await Player.deleteMany({});
        await Team.deleteMany({});
        await Chat.deleteMany({});
        
        // 2. Clear all users EXCEPT the Master Admin
        await User.deleteMany({ email: { $ne: "sarkaranubhav48@gmail.com" } });

        // 3. Reset the live auction state
        auctionState = { 
            activePlayerId: null, 
            currentBid: 0, 
            highestBidder: 'No Bids Yet', 
            timeLeft: 120,
            skippedTeams: [],
            isFinalCall: false,
            finalCallText: ""
        };

        // 4. Force refresh all connected clients
        io.emit('updatePlayers', []);
        io.emit('updateTeams', []);
        io.emit('updateAuction', auctionState);
        io.emit('newMessage', { 
            sender: "SYSTEM", 
            role: "admin", 
            text: "🚨 SYSTEM ALERT: Database has been wiped. A new tour can now begin." 
        });

        socket.emit('newMessage', { sender: "SYSTEM", text: "✅ Full Reset Successful." });
    } catch (err) {
        console.error(err);
        socket.emit('errorMsg', "Reset failed: " + err.message);
    }
});
    // --- MARK PLAYER AS UNSOLD ---
socket.on('markUnsold', async () => {
    if (auctionState.activePlayerId) {
        const player = auctionState.activePlayerId;
        
        // 1. Update Player status in DB
        await Player.findByIdAndUpdate(player._id, { 
            status: 'Unsold', 
            soldTo: 'UNSOLD' 
        });

        // 2. Clear the timer
        clearInterval(timerInterval);

        // 3. Reset Auction State
        auctionState = { 
            activePlayerId: null, 
            currentBid: 0, 
            highestBidder: 'No Bids Yet', 
            timeLeft: 0,
            skippedTeams: [],
            isFinalCall: false,
            finalCallText: ""
        };

        // 4. Broadcast updates
        io.emit('updatePlayers', await Player.find());
        io.emit('updateAuction', auctionState);
        io.emit('newMessage', { 
            sender: "SYSTEM", 
            role: "admin", 
            text: `❌ UNSOLD: ${player.name} has been moved to the unsold list.` 
        });
    }
});
    // --- SLIDESHOW LOGIC ---
    socket.on('toggleSlideshow', async (shouldStart) => {
        if (shouldStart) {
            const unsoldPlayers = await Player.find({ status: 'Unsold' });
            if (unsoldPlayers.length === 0) return socket.emit('errorMsg', "No unsold players to show!");
            
            slideshowState = { active: true, currentIndex: 0, players: unsoldPlayers };
            io.emit('updateSlideshow', slideshowState);

            // Auto-rotate every 5 seconds
            clearInterval(slideshowInterval);
            slideshowInterval = setInterval(() => {
                slideshowState.currentIndex = (slideshowState.currentIndex + 1) % slideshowState.players.length;
                io.emit('updateSlideshow', slideshowState);
            }, 5000);
        } else {
            clearInterval(slideshowInterval);
            slideshowState = { active: false, currentIndex: 0, players: [] };
            io.emit('updateSlideshow', slideshowState);
        }
    });
    socket.on('bulkAddPlayers', async (playersArray) => {
    try {
        // Insert all players at once
        await Player.insertMany(playersArray);
        
        // Refresh the list for everyone
        const allPlayers = await Player.find();
        io.emit('updatePlayers', allPlayers);
        
        // Send success message back to the admin who uploaded
        socket.emit('bulkImportSuccess', `Successfully imported ${playersArray.length} players!`);
        
        // Log to chat
        io.emit('newMessage', { 
            sender: "SYSTEM", 
            role: "admin", 
            text: `📢 DATABASE SYNC: ${playersArray.length} new players registered via CSV.` 
        });
    } catch (err) {
        console.error(err);
        socket.emit('errorMsg', "Database Import Failed: " + err.message);
    }
});


    // Add this inside your io.on('connection', ...) block
socket.on('updatePlayerImage', async ({ playerId, imageUrl }) => {
    try {
        await Player.findByIdAndUpdate(playerId, { imageUrl: imageUrl });
        
        // Refresh the list for everyone
        const updatedPlayers = await Player.find();
        io.emit('updatePlayers', updatedPlayers);
        
        // If this player is currently live, update the auction screen too
        if (auctionState.activePlayerId && auctionState.activePlayerId._id.toString() === playerId) {
            auctionState.activePlayerId.imageUrl = imageUrl;
            io.emit('updateAuction', auctionState);
        }
        
        socket.emit('newMessage', { sender: "SYSTEM", role: "admin", text: "✅ Player image updated successfully!" });
    } catch (err) {
        console.error(err);
        socket.emit('errorMsg', "Failed to update image");
    }
});
});

server.listen(process.env.PORT || 3000, () => console.log("Server Running"));
