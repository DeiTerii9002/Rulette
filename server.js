const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static(path.join(__dirname, 'public')));

let rooms = {};

function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function getRoomsList() {
    return Object.values(rooms).map(room => ({
        id: room.id,
        playerCount: room.players.length,
        inGame: room.gameStarted
    }));
}

io.on('connection', (socket) => {
    console.log('New connection:', socket.id);
    let user = null;
    let currentRoom = null;

    socket.on('set-user', (username) => {
        user = username;
        console.log(`User ${user} set for ${socket.id}`);
        socket.emit('user-set', user);
    });

    socket.on('get-rooms', () => {
        socket.emit('rooms-list', getRoomsList());
    });

    socket.on('create-room', () => {
        if (!user) {
            socket.emit('error', 'Not logged in');
            return;
        }
        if (currentRoom) {
            socket.emit('error', 'You are already in a room');
            return;
        }
        const roomId = generateRoomId();
        rooms[roomId] = {
            id: roomId,
            players: [{ id: socket.id, name: user, isCreator: true }],
            gameStarted: false,
            currentTurn: 0,
            chamber: 0
        };
        currentRoom = roomId;
        socket.join(roomId);
        socket.emit('room-created', roomId);
        io.emit('rooms-list', getRoomsList());
        console.log(`Room ${roomId} created by ${user}`);
    });

    socket.on('join-room', (roomId) => {
        if (!user) {
            socket.emit('error', 'Not logged in');
            return;
        }
        if (currentRoom) {
            socket.emit('error', 'You are already in a room');
            return;
        }
        const room = rooms[roomId];
        if (!room) {
            socket.emit('error', 'Room not found');
            return;
        }
        if (room.gameStarted) {
            socket.emit('error', 'Game already started');
            return;
        }
        if (room.players.length >= 6) {
            socket.emit('error', 'Room is full');
            return;
        }
        if (room.players.some(p => p.name === user)) {
            socket.emit('error', 'Already in this room');
            return;
        }
        room.players.push({ id: socket.id, name: user, isCreator: false });
        currentRoom = roomId;
        socket.join(roomId);
        socket.emit('joined-room', roomId);
        io.to(roomId).emit('room-players', room.players);
        io.emit('rooms-list', getRoomsList());
        console.log(`${user} joined room ${roomId}`);
    });

    socket.on('start-game', () => {
        if (!currentRoom) return;
        const room = rooms[currentRoom];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player || !player.isCreator) {
            socket.emit('error', 'Only creator can start');
            return;
        }
        if (room.gameStarted) return;
        
        room.gameStarted = true;
        room.currentTurn = 0;
        room.chamber = Math.floor(Math.random() * 6);
        
        io.to(currentRoom).emit('game-started', {
            players: room.players.map(p => ({ id: p.id, name: p.name })),
            firstPlayer: room.players[0].id
        });
    });

    socket.on('shoot', () => {
        if (!currentRoom) return;
        const room = rooms[currentRoom];
        if (!room || !room.gameStarted) return;
        if (room.players[room.currentTurn].id !== socket.id) return;
        
        const isDead = room.chamber === 0;
        io.to(currentRoom).emit('shot-result', { player: socket.id, dead: isDead });
        
        if (isDead) {
            const index = room.players.findIndex(p => p.id === socket.id);
            room.players.splice(index, 1);
            io.to(currentRoom).emit('player-left', { players: room.players.map(p => ({ id: p.id, name: p.name })) });
            
            if (room.players.length <= 1) {
                const winner = room.players.length === 1 ? room.players[0].name : null;
                io.to(currentRoom).emit('game-ended', { winner });
                delete rooms[currentRoom];
                currentRoom = null;
                io.emit('rooms-list', getRoomsList());
                return;
            }
            if (room.currentTurn >= room.players.length) room.currentTurn = 0;
            io.to(currentRoom).emit('turn-change', { player: room.players[room.currentTurn].id });
            room.chamber = Math.floor(Math.random() * 6);
        } else {
            room.chamber = (room.chamber + 1) % 6;
            room.currentTurn = (room.currentTurn + 1) % room.players.length;
            io.to(currentRoom).emit('turn-change', { player: room.players[room.currentTurn].id });
        }
    });

    socket.on('leave-room', () => {
        if (!currentRoom) return;
        const room = rooms[currentRoom];
        if (room) {
            const index = room.players.findIndex(p => p.id === socket.id);
            if (index !== -1) room.players.splice(index, 1);
            if (room.players.length === 0) {
                delete rooms[currentRoom];
            } else if (room.gameStarted) {
                io.to(currentRoom).emit('game-ended', { winner: null });
                delete rooms[currentRoom];
            } else {
                io.to(currentRoom).emit('room-players', room.players);
            }
            io.emit('rooms-list', getRoomsList());
        }
        socket.leave(currentRoom);
        currentRoom = null;
        socket.emit('left-room');
    });

    socket.on('disconnect', () => {
        console.log('Disconnected:', socket.id);
        if (currentRoom) {
            const room = rooms[currentRoom];
            if (room) {
                const index = room.players.findIndex(p => p.id === socket.id);
                if (index !== -1) room.players.splice(index, 1);
                if (room.players.length === 0) {
                    delete rooms[currentRoom];
                } else if (room.gameStarted) {
                    io.to(currentRoom).emit('game-ended', { winner: null });
                    delete rooms[currentRoom];
                } else {
                    io.to(currentRoom).emit('room-players', room.players);
                }
                io.emit('rooms-list', getRoomsList());
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));