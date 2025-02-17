import { createServer } from 'node:http';
import next from 'next';
import { Server } from 'socket.io';
import pkg from 'pg';
const { Client } = pkg;

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOSTNAME || 'localhost';
const port = process.env.PORT || '3005';

// Database client initialization
const client = new Client({
    connectionString: process.env.DATABASE_URL,
});

client.connect().then(() => {
    console.log('Connected to PostgreSQL database');
}).catch((error) => {
    console.error('Failed to connect to PostgreSQL:', error);
});

// Fetch available rooms from DB
const getRoomsFromDB = async (type = null) => {
    try {
        let query = 'SELECT name FROM rooms';
        let params = [];
        if (type) {
            query += ' WHERE type = $1';
            params.push(type);
        }
        const res = await client.query(query, params);
        return res.rows.map(row => row.name);
    } catch (error) {
        console.error('Error fetching rooms from DB:', error);
        return [];
    }
};

// Handle room creation (chat or game)
const createRoomInDB = async (newRoom, type) => {
    try {
        const checkRes = await client.query('SELECT * FROM rooms WHERE name = $1', [newRoom]);
        if (checkRes.rows.length > 0) return null;  // Room already exists
        await client.query('INSERT INTO rooms (name, type) VALUES ($1, $2) RETURNING *', [newRoom, type]);
        return newRoom;
    } catch (error) {
        console.error('Error creating room in DB:', error);
        return null;
    }
};

// Save message to the database
const saveMessageToDatabase = async (room, message, sender) => {
    try {
        const res = await client.query('INSERT INTO messages (room_name, message, sender) VALUES ($1, $2, $3) RETURNING *', [room, message, sender]);
        console.log('Message saved to DB:', res.rows[0]);
    } catch (error) {
        console.error('Error saving message to DB:', error);
    }
};

// Get message history
export async function getMessagesFromDB(roomName) {
    try {
        const res = await client.query(
            'SELECT sender, message, created_at FROM messages WHERE room_name = $1 ORDER BY created_at ASC',
            [roomName]
        );
        return res.rows;
    } catch (error) {
        console.error('Error fetching messages from DB:', error);
        return [];
    }
};

// Socket event handling
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
    const httpServer = createServer(handle);
    const io = new Server(httpServer, {
        cors: {
            origin: "*",
            methods: ["GET", "POST"],
            allowedHeaders: ["Content-Type"],
            credentials: true,
        },
        pingInterval: 25000,  // Send ping every 25 seconds
        pingTimeout: 60000,   // Timeout if no pong response in 60 seconds
    });

    io.on('connection', (socket) => {
        console.log(`A player connected: ${socket.id}`);

        // Handle 'createGameRoom' event (creating a game room)
        socket.on("createGameRoom", async (roomName, gameType) => {
            try {
                const roomCreated = await createRoomInDB(roomName, "game");
                if (!roomCreated) {
                    socket.emit("createRoomResponse", { success: false, error: "Room already exists!" });
                    return;
                }

                socket.join(roomName);
                socket.emit("createRoomResponse", { success: true, room: roomName });

                io.emit("availableRooms", await getRoomsFromDB("game"));  // Broadcast updated game rooms
            } catch (error) {
                console.error('Error creating game room:', error);
                socket.emit("createRoomResponse", { success: false, error: "Error creating room" });
            }
        });

        // Handle 'joinGameRoom' event (joining a game room)
        socket.on("joinGameRoom", async (roomName, userName) => {
            try {
                const room = await client.query('SELECT * FROM rooms WHERE name = $1 AND type = $2', [roomName, 'game']);
                if (!room.rows.length) {
                    socket.emit("joinRoomError", { error: "Game room not found!" });
                    return;
                }

                socket.join(roomName);
                io.to(roomName).emit("user_joined", `${userName} has joined the game!`);
            } catch (error) {
                console.error('Error joining game room:', error);
            }
        });

        // Handle 'createRoom' event (creating a chat room)
        socket.on('createRoom', async (newRoom) => {
            try {
                const roomCreated = await createRoomInDB(newRoom, 'chat');
                if (!roomCreated) {
                    socket.emit('createRoomResponse', { success: false, error: 'Room already exists' });
                    return;
                }

                socket.join(newRoom);
                socket.emit('createRoomResponse', { success: true, room: newRoom });

                io.emit('availableRooms', await getRoomsFromDB('chat'));  // Broadcast updated chat rooms
            } catch (error) {
                console.error('Error creating chat room:', error);
                socket.emit('createRoomResponse', { success: false, error: 'Error creating room' });
            }
        });

        // Handle 'join-room' event (joining a chat room)
        socket.on('join-room', async ({ room, userName }) => {
            try {
                const roomExist = await client.query('SELECT * FROM rooms WHERE name = $1 AND type = $2', [room, 'chat']);
                if (!roomExist.rows.length) {
                    socket.emit("joinRoomError", { error: "Chat room does not exist!" });
                    return;
                }

                socket.join(room);
                const messages = await getMessagesFromDB(room);
                socket.emit('messageHistory', messages, room);
                io.to(room).emit('user_joined', `${userName} has joined the room: ${room}`);
            } catch (error) {
                console.error('Error in join-room handler:', error);
            }
        });

        // Handle sending messages (chat messages)
        socket.on('message', async ({ room, message, sender }) => {
            try {
                const roomType = await client.query('SELECT type FROM rooms WHERE name = $1', [room]);
                if (roomType.rows[0].type !== 'chat') return;  // Ignore messages in game rooms

                await saveMessageToDatabase(room, message, sender);
                io.to(room).emit('newMessage', { sender, message, room });
            } catch (error) {
                console.error('Error saving message to DB:', error);
            }
        });

        // Handle 'gameMessage' event (game-specific messages)
        socket.on("gameMessage", (data) => {
            const { room, message } = data;
            socket.to(room).emit("newMessage", message);  // Send game-specific message
        });

        // Handle leave-room event
        socket.on('leave-room', (room, userName) => {
            console.log(`User: ${userName}, has left the room: ${room}`);
            socket.leave(room);
            socket.to(room).emit('user_left', `${userName} has left the room`);
        });

        // Handle removeRoom event (for chat or game)
        socket.on("removeRoom", async (roomToRemove) => {
            try {
                await client.query('DELETE FROM messages WHERE room_name = $1', [roomToRemove]);
                await client.query('DELETE FROM rooms WHERE name = $1', [roomToRemove]);
                const updatedRooms = await getRoomsFromDB();
                io.emit("availableRooms", updatedRooms);  // Emit updated room list
            } catch (error) {
                console.error("Error deleting room and messages:", error);
            }
        });
    });

    // Start the server
    httpServer.listen(port, '0.0.0.0', () => {
        console.log(`Server listening on http://${hostname}:${port}`);
    });
}).catch ((err) => {
    console.error('Error preparing app:', err);
});
