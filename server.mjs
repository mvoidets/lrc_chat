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
        
        console.log('Executing query:', query, params);
        const res = await client.query(query, params);
        console.log(`Fetched rooms:`, res.rows);

        return res.rows.map(row => row.name);
    } catch (error) {
        console.error('Error fetching rooms from DB:', error);
        return [];
    }
};

const getRoomByName = async (roomName) => {
    try {
        const result = await client.query('SELECT * FROM rooms WHERE name = $1', [roomName]);
        return result.rows[0];  // Return the first row (room) if found
    } catch (error) {
        console.error("Error fetching room by name:", error);
        return null;
    }
};


// Handle room creation (chat or game)
const createRoomInDB = async (newRoom, type) => {
    if (!newRoom) {
        console.error("Room name is invalid (null or undefined).");
        return null;  // Ensure the room name is not empty or undefined.
    }

    try {
        console.log(`Checking if room ${newRoom} exists...`);

            // Ensure client is active
            if (!client || !client.query) {
                console.error("Database client is not active or not connected.");
                return null;
            }
    
        const checkRes = await client.query('SELECT * FROM rooms WHERE name = $1', [newRoom]);

        if (checkRes.rows.length > 0) {
            console.log(`Room ${newRoom} already exists.`);
            return null;  // Room already exists
        }

        console.log(`Room ${newRoom} does not exist, creating room...`);
        await client.query('INSERT INTO rooms (name, type) VALUES ($1, $2)', [newRoom, type]);
        console.log(`Room ${newRoom} created successfully.`);

        return newRoom;
    } catch (error) {
        console.error('Error creating room in DB:', error);
        return null;
    }
};



// Save message to the database (with type)
const saveMessageToDatabase = async (room, message, sender, type) => {
    try {
        const res = await client.query('INSERT INTO messages (room_name, message, sender, type) VALUES ($1, $2, $3, $4) RETURNING *', [room, message, sender, type]);
        console.log('Message saved to DB:', res.rows[0]);
    } catch (error) {
        console.error('Error saving message to DB:', error);
    }
};


// Get message history
export async function getMessagesFromDB(roomName, limit = 50, offset = 0) {
    try {
        const res = await client.query(
            'SELECT sender, message, created_at FROM messages WHERE room_name = $1 ORDER BY created_at ASC',
            [roomName, limit, offset]
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
                // Create the game room in the DB
                const roomCreated = await createRoomInDB(roomName, "game");
                if (!roomCreated) {
                    socket.emit("createRoomResponse", { success: false, error: "Room already exists!" });
                    return;
                }

                // Create the associated chat room (name of chat room is the game room name + "-chat")
                const chatRoomName = `${roomName}-chat`;  // e.g., "gameRoom1-chat"
                await createRoomInDB(chatRoomName, "chat");

                // Join both the game and chat rooms
                socket.join(roomName);  // Join game room
                socket.join(chatRoomName);  // Join chat room

                // Emit the success response with room name
                socket.emit("createRoomResponse", { success: true, room: roomName });

                // Emit the updated list of available rooms (game rooms)
                io.emit("availableRooms", await getRoomsFromDB());  // Broadcast updated game rooms to all clients

            } catch (error) {
                console.error('Error creating game room:', error);
                socket.emit("createRoomResponse", { success: false, error: "Error creating room" });
            }
        });


        // Handle 'joinGameRoom' event (joining a game room)
        socket.on("joinGameRoom", async (roomName, userName) => {
                   
            try {
                const roomRes = await client.query('SELECT * FROM rooms WHERE name = $1 AND type = $2', [roomName, 'game']);
                if (!roomRes.rows.length === 0) {
                    socket.emit("joinRoomError", { error: "Game room not found!" });
                    return;
                }

                socket.join(roomName);
                io.to(roomName).emit("user_joined", `${userName} has joined the game!`);
            } catch (error) {
                console.error('Error joining game room:', error);
                socket.emit("joinRoomError", { error: "An error occurred while joining the game room." });
            }
        });


      
        // Handle 'createRoom' event (creating a chat room)
        socket.on('createRoom', async ({ name, type }) => {
            try {
                if (!name || !type) {
                    socket.emit('createRoomResponse', { success: false, error: 'Room name and type are required!' });
                    return;
                }
        
                // Check if room already exists (optional)
                const existingRoom = await getRoomByName(name);
                if (existingRoom) {
                    socket.emit('createRoomResponse', { success: false, error: 'Room already exists' });
                    return;
                }
        
                // Insert the room into the database (using your DB function)
                const roomCreated = await createRoomInDB(name, type);
                if (!roomCreated) {
                    socket.emit('createRoomResponse', { success: false, error: 'Error creating room' });
                    return;
                }
        
                // Emit success and the new room name
                socket.emit('createRoomResponse', { success: true, room: name });
        
                // Optionally, you can emit the updated room list
                const allRooms = await getRoomsFromDB(); // Fetch all rooms
                io.emit('availableRooms', allRooms); // Broadcast updated room list
        
            } catch (error) {
                console.error('Error creating room:', error);
                socket.emit('createRoomResponse', { success: false, error: 'Server error while creating room' });
            }
        });

        // socket.on('createRoom', async (newRoom, type) => {
        //     try {
        //         const roomCreated = await createRoomInDB(newRoom, type);
        //         if (!roomCreated) {
        //             socket.emit('createRoomResponse', { success: false, error: 'Room already exists' });
        //             return;
        //         }

        //         socket.join(newRoom);
        //         socket.emit('createRoomResponse', { success: true, room: newRoom, type: type });

        //         io.emit('availableRooms', await getRoomsFromDB('chat'));  // Broadcast updated chat rooms
        //     } catch (error) {
        //         console.error('Error creating chat room:', error);
        //         socket.emit('createRoomResponse', { success: false, error: 'Error creating room' });
        //     }
        // });

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

        // //create gameroom

        // socket.on("createGameRoom", async (roomName, gameType) => {
        //     try {
        //         // Create game room
        //         const roomCreated = await createRoomInDB(roomName, "game");
        //         if (!roomCreated) {
        //             socket.emit("createRoomResponse", { success: false, error: "Room already exists!" });
        //             return;
        //         }

        //         // Create associated chat room
        //         const chatRoomName = `${roomName}-chat`; // e.g., "gameRoom1-chat"
        //         await createRoomInDB(chatRoomName, "chat");

        //         socket.join(roomName);  // Join game room
        //         socket.join(chatRoomName);  // Join corresponding chat room
        //         socket.emit("createRoomResponse", { success: true, room: roomName });

        //         // Update available rooms
        //         io.emit("availableRooms", await getRoomsFromDB("game"));  // For game rooms
        //     } catch (error) {
        //         console.error('Error creating game room:', error);
        //         socket.emit("createRoomResponse", { success: false, error: "Error creating room" });
        //     }
        // });

        // Handle sending messages (chat messages)
        socket.on('message', async ({ room, message, sender }) => {
            try {
                // Fetch room type from DB to ensure it's a chat room
                const roomTypeRes = await client.query('SELECT type FROM rooms WHERE name = $1', [room]);
                const roomType = roomTypeRes.rows[0].type;

                if (roomType !== 'chat') return;  // Ignore messages in non-chat rooms

                await saveMessageToDatabase(room, message, sender, 'chat'); // Save as chat message
                io.to(room).emit('newMessage', { sender, message });
            } catch (error) {
                console.error('Error saving message to DB:', error);
            }
        });

        // Handle 'gameMessage' event (game-specific messages)
        socket.on("gameMessage", async (data) => {
            const { room, message, sender } = data;

            try {
                // Fetch room type to make sure it's a game room
                const roomTypeRes = await client.query('SELECT type FROM rooms WHERE name = $1', [room]);
                const roomType = roomTypeRes.rows[0].type;

                if (roomType !== 'game') return;  // Ignore messages in non-game rooms

                // Send game-specific message
                socket.to(room).emit("gameMessage", { sender, message });
            } catch (error) {
                console.error('Error in game message handling:', error);
            }
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
                // Notify users about the room deletion
                io.to(roomToRemove).emit("room_removed", `Room "${roomToRemove}" has been removed.`);
        
                // Clean up messages and room data from DB
                await client.query('DELETE FROM messages WHERE room_name = $1', [roomToRemove]);
                await client.query('DELETE FROM rooms WHERE name = $1', [roomToRemove]);
        
                // Emit updated list of available rooms
                const updatedRooms = await getRoomsFromDB();
                io.emit("availableRooms", updatedRooms);  // Broadcast updated room list to all clients
        
            } catch (error) {
                console.error("Error deleting room and messages:", error);
                io.to(roomToRemove).emit("room_removed_error", "An error occurred while deleting the room.");
            }
        });
        
    });

    // Start the server
    httpServer.listen(port, '0.0.0.0', () => {
        console.log(`Server listening on http://${hostname}:${port}`);
    });
}).catch((err) => {
    console.error('Error preparing app:', err);
});
