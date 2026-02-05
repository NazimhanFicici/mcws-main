import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer, Socket as SocketIOSocket } from 'socket.io';
import WebSocket, { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { parse } from 'url';
//import { handler } from '../build/handler.js';

// Import our library modules
import { Config } from './lib/types.js';
import { logger } from './lib/logger.js';
import { MinecraftManager } from './lib/minecraft-manager.js';
import { getClientAddress, createSubscriptionMessage } from './lib/utils.js';

// Configuration
const config: Config = {
	PORT: process.env.PORT ? parseInt(process.env.PORT, 10) : 3000,
	MINECRAFT_WS_PORT: process.env.MINECRAFT_WS_PORT
		? parseInt(process.env.MINECRAFT_WS_PORT, 10)
		: 8080
};
// Store for PIN codes - maps PIN to client info
interface PinEntry {
	clientId: string;
	pin: string;
	uuid: string;
	createdAt: Date;
	isUsed: boolean;
}

const activePins = new Map<string, PinEntry>();

// Store for pending connections without parameters (awaiting validation)
interface PendingConnection {
	clientId: string;
	socket: WebSocket;
	address: string;
	port: number;
	createdAt: Date;
	isValidated: boolean;
	webSocketId?: number;
}

const pendingConnections = new Map<string, PendingConnection>();

function isJSON(str: string): boolean {
  try {
    JSON.parse(str);
    return true;
  } catch {
    return false;
  }
}

// Function to register session with Xano API and get web_socket_id
async function registerSessionWithXano(): Promise<{ success: boolean; webSocketId?: number; error?: string }> {
	try {
		const response = await fetch("https://xav2-ouin-xo2r.f2.xano.io/api:E-ut2caw/minecraft_test/id_web_socket", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Data-Source": "dev"
			},
			body: JSON.stringify({})
		});

		if (!response.ok) {
			return { success: false, error: `API responded with status ${response.status}` };
		}

		const result = await response.json();
		
		if (result && typeof result.web_socket_id === 'number') {
			logger.log(`✅ Xano API returned web_socket_id: ${result.web_socket_id}`);
			return { success: true, webSocketId: result.web_socket_id };
		} else {
			return { success: false, error: 'Invalid response format from Xano API' };
		}
	} catch (error) {
		logger.error('Error calling Xano API:', error);
		return { success: false, error: String(error) };
	}
}

// Server setup
const app = express();
const httpServer = createServer(app);
var gascId2 = 0;
var userId2 = 0;
var loggedIn2 = "";
const io = new SocketIOServer(httpServer, {
	cors: { origin: '*', methods: ['GET', 'POST'] }
});
const minecraftWss = new WebSocketServer({ port: config.MINECRAFT_WS_PORT });

async function sendToXano(data: any) {
	if(gascId2 != 0) {
  	const response = await fetch("https://xav2-ouin-xo2r.f2.xano.io/api:K_1rYoDD/minecraftTest", {
		method: "POST",
		headers: {
		"Content-Type": "application/json"
		},
		body: JSON.stringify({ inputData: data, gascId: gascId2, userId: userId2, dummy: loggedIn2 })
	});
  	const result = await response.json();
};
};
// Initialize Minecraft Manager
const minecraftManager = new MinecraftManager();

// Set up callbacks
minecraftManager.setCallbacks({
	onActivity: (activity) => io.emit('activity_update', activity),
	onClientUpdate: () => io.emit('clients_update', minecraftManager.getClientList()),
	onData: (type, data) => io.emit('minecraft_data', { type, ...data })
});

// Minecraft WebSocket Server
minecraftWss.on('connection', async (socket: WebSocket, request) => {
	const clientId = uuidv4();
	const input = request;
	const rawHeaders = input.rawHeaders;

	// Parse query parameters from Host header
	let gascIdParam: string | null = null;
	let userIdParam: string | null = null;
	let webSocketIdParam: string | null = null;
	let hasParameters = false;

	// Find the index of "Host"
	const hostIndex = rawHeaders.findIndex(h => h.toLowerCase() === "host");
	if (hostIndex !== -1 && rawHeaders[hostIndex + 1]) {
		const hostValue = rawHeaders[hostIndex + 1]; // e.g., "localhost:8080?gascId=41"
		
		// Parse query string
		const urlObj = new URL("http://" + hostValue); // add scheme to make it a valid URL
		userIdParam = urlObj.searchParams.get("userId");
		gascIdParam = urlObj.searchParams.get("gascId");
		gascId2 = gascIdParam ? parseInt(gascIdParam, 10) : 0;
		userId2 = userIdParam ? parseInt(userIdParam, 10) : 0;
		
		
		webSocketIdParam = urlObj.searchParams.get("web_socket_id");
		
		// Check if any parameter exists
		hasParameters = !!( userId2 != 0|| gascId2 != 0 || webSocketIdParam);
	}

	const address = getClientAddress(request);
	const port = request.socket.remotePort || 0;
	const sixDigitCode = Math.floor(100000 + Math.random() * 900000).toString();
	const uuid = uuidv4();

	logger.log(`🔗 New connection attempt from ${address}:${port}`);
	logger.log(`   Parameters: gascId=${gascId2}, userId=${userId2}, web_socket_id=${webSocketIdParam}`);
	logger.log(`   Has parameters: ${hasParameters}`);

	// ========================================
	// CASE 1: Connection WITHOUT parameters
	// Use testfor to count players, validate, then register with Xano
	// ========================================
	if (!hasParameters) {
		logger.log(`⚠️ Connection WITHOUT parameters detected from ${address}:${port}`);
		
		let validationDone = false;
		let socketErrorOccurred = false;
		
		// Add error handler FIRST to prevent server crash
		socket.on('error', (err: Error) => {
			logger.log(`⚠️ Socket error: ${err.message}`);
			socketErrorOccurred = true;
			
			// If socket error with code 59395, user is not hosting
			if (err.message.includes('59395') || err.message.includes('invalid status code')) {
				logger.log(`📢 User is not hosting the world - cannot connect`);
			}
		});
		
		// Add close handler
		socket.on('close', () => {
			logger.log(`🔌 Socket closed for client ${clientId}`);
			minecraftManager.removeClient(clientId);
		});

		// Add client
		const client = minecraftManager.addClient(clientId, socket, address, port);
		
		// Use testfor to count players - the response will tell us how many
		minecraftManager.sendCommand('/testfor @a', clientId);
		logger.log(`📤 Checking player count with /testfor @a...`);
		
		// Listen for testfor response
		socket.on('message', async (packet: WebSocket.RawData) => {
			try {
				
				const message = JSON.parse(packet.toString());
				
				// Check for testfor response - contains player names
				if (!validationDone && message?.body?.statusMessage && 
				    message.body.statusMessage.includes('Found')) {
					
					// Parse "Found PlayerName1, PlayerName2" or "Found PlayerName"
					const statusMsg = message.body.statusMessage;
					const foundMatch = statusMsg.match(/Found (.+)/);
					
					if (foundMatch) {
						const playersString = foundMatch[1];
						// Count players by splitting on comma
						const playerCount = playersString.split(',').length;
						
						logger.log(`👥 Detected ${playerCount} player(s): ${playersString}`);
						validationDone = true;
						
						if (playerCount < 2) {
							// ❌ Not enough players - reject and close
							logger.log(`❌ Only ${playerCount} player(s) - need 2+. Rejecting connection.`);
							
							// Send rejection messages
							minecraftManager.sendCommand('/tellraw @a {"rawtext":[{"text":"§c§l✗ Connection rejected!"}]}', clientId);
							minecraftManager.sendCommand('/tellraw @a {"rawtext":[{"text":"§eYou need at least 2 players in multiplayer."}]}', clientId);
							minecraftManager.sendCommand(`/tellraw @a {"rawtext":[{"text":"§7Current players: ${playerCount}/2 required"}]}`, clientId);
							minecraftManager.sendCommand('/tellraw @a {"rawtext":[{"text":"§7Invite another player and run /connect again."}]}', clientId);
							
							// Close socket QUICKLY after sending messages
							setTimeout(() => {
								try {
									if (socket.readyState === WebSocket.OPEN) {
										minecraftManager.removeClient(clientId);
										socket.close(1000, 'Not enough players');
									}
								} catch (err) {
									logger.log(`⚠️ Error closing: ${err}`);
								}
							}, 500); // Reduced from 1000 to 500ms
							return;
						}
						
						// ✅ 2+ players - proceed with Xano registration
						logger.log(`✅ ${playerCount} players validated. Registering with Xano...`);
						
						// Notify Minecraft
						minecraftManager.sendCommand('/tellraw @a {"rawtext":[{"text":"§e⏳ Validating players..."}]}', clientId);
						minecraftManager.sendCommand(`/tellraw @a {"rawtext":[{"text":"§a✓ ${playerCount} players detected. Registering session..."}]}`, clientId);
						
						// Teleport players to lobby - correct lobby coordinates from teleport/spawn.mcfunction
						minecraftManager.sendCommand('/tp @a 159.59 -43.00 679.50 90 -10', clientId);
						minecraftManager.sendCommand('/effect @a instant_health 1 255 true', clientId); // Heal players
						minecraftManager.sendCommand('/gamemode adventure @a', clientId); // Set adventure mode
						minecraftManager.sendCommand('/camera @a fade time 0.5 1 0.5', clientId);
						
						// Call Xano API
						const xanoResult = await registerSessionWithXano();
						
						if (!xanoResult.success || !xanoResult.webSocketId) {
							logger.error(`❌ Xano API failed: ${xanoResult.error}`);
							minecraftManager.sendCommand('/tellraw @a {"rawtext":[{"text":"§c§l❌ Failed to register session!"}]}', clientId);
							return;
						}
						
						const webSocketId = xanoResult.webSocketId;
						logger.log(`✅ Session registered. web_socket_id: ${webSocketId}`);
						
						// Send success messages
						minecraftManager.sendCommand('/tellraw @a {"rawtext":[{"text":""}]}', clientId);
						minecraftManager.sendCommand('/tellraw @a {"rawtext":[{"text":"§a§l✅ Registration successful!"}]}', clientId);
						minecraftManager.sendCommand('/tellraw @a {"rawtext":[{"text":""}]}', clientId);
						minecraftManager.sendCommand('/tellraw @a {"rawtext":[{"text":"§e📋 Copy and paste the following command:"}]}', clientId);
						minecraftManager.sendCommand('/tellraw @a {"rawtext":[{"text":""}]}', clientId);
						minecraftManager.sendCommand(`/tellraw @a {"rawtext":[{"text":"§b/connect ws://localhost:${config.MINECRAFT_WS_PORT}?web_socket_id=${webSocketId}"}]}`, clientId);
						minecraftManager.sendCommand('/tellraw @a {"rawtext":[{"text":""}]}', clientId);
						minecraftManager.sendCommand(`/tellraw @a {"rawtext":[{"text":"§7Your WebSocket ID: §f${webSocketId}"}]}`, clientId);
						
						// Send scriptevent for game script
						minecraftManager.sendCommand(`/scriptevent daigon:websocket_id_received ${webSocketId}`, clientId);
						logger.log(`📤 Sent web_socket_id: ${webSocketId}`);
						
						// Close socket after sending the web_socket_id
						// User needs to reconnect with ?web_socket_id=XXX parameter
						setTimeout(() => {
							try {
								if (socket.readyState === WebSocket.OPEN) {
									logger.log(`🔌 Closing CASE 1 socket - user should reconnect with web_socket_id parameter`);
									minecraftManager.removeClient(clientId);
									socket.close(1000, 'Session registered - reconnect with web_socket_id');
								}
							} catch (err) {
								logger.log(`⚠️ Error closing socket: ${err}`);
							}
						}, 2000); // Give 2 seconds for messages to be received
						
						return;
					}
				}
				
				// DON'T process pings in CASE 1 - this is just for validation/registration
				// Skip processMessage to avoid infinite ping loop
				if (validationDone) {
					// Validation done but not yet closed - just log, don't process
					logger.log(`📨 [CASE1-ignore] Message from ${clientId} (waiting for socket close)`);
					return;
				}
				
				// Log other messages only during validation phase
				logger.log(`📨 From MC client ${clientId}:`, JSON.stringify(message, null, 2));
			} catch (error) {
				logger.error(`Error parsing message: ${error}`);
			}
		});
		
		// Timeout - reduced to 2 seconds for faster rejection
		setTimeout(() => {
			if (!validationDone) {
				if (socketErrorOccurred) {
					// Socket error occurred - user is NOT hosting
					logger.log(`❌ Socket error during validation - user must host a multiplayer world`);
				} else {
					logger.log(`⏰ Validation timeout - no response from Minecraft`);
				}
				try {
					if (socket.readyState === WebSocket.OPEN) {
						minecraftManager.removeClient(clientId);
						socket.close(1000, 'Validation timeout');
					}
				} catch (err) {
					logger.log(`⚠️ Error on timeout: ${err}`);
				}
			}
		}, 2000);
		
		return;
	}

	// ========================================
	// CASE 2: Connection WITH parameters (existing flow)
	// ========================================
	logger.log(`✅ Connection WITH parameters - proceeding with normal flow`);
	
	const client = minecraftManager.addClient(clientId, socket, address, port);
	logger.log(`✅ Minecraft client connected: ${clientId} from ${address}:${port}`);

	// Store the PIN
	const pinEntry: PinEntry = {
		clientId,
		pin: sixDigitCode,
		uuid,
		createdAt: new Date(),
		isUsed: false
	};
	activePins.set(sixDigitCode, pinEntry);

	logger.log(`📌 Generated test123  PIN ${sixDigitCode} for client ${clientId} with UUID ${uuid}`);

	// Send initial commands
	minecraftManager.sendCommand('/scriptevent daigon:webhook_connected', clientId);
	minecraftManager.sendCommand(`/scriptevent daigon:webhook_code ${sixDigitCode}`, clientId);
	socket.send(createSubscriptionMessage());
	minecraftManager.sendCommand("/scriptevent daigon:wss_connected", clientId)
	
	
	// Check if this is a reconnection with web_socket_id (from initial connection flow)
	if (webSocketIdParam) {
		// This is a reconnection after getting web_socket_id from initial flow
		logger.log(`🔗 Reconnection with web_socket_id: ${webSocketIdParam}`);
		
		// Send params_connected for immediate connection (no validation)
		minecraftManager.sendCommand("/scriptevent daigon:wss_params_connected", clientId);
		minecraftManager.sendCommand('/tellraw @a {"rawtext":[{"text":"§a§l✓ Connection verified! Welcome to the game!"}]}', clientId);
	} else if (gascIdParam && userIdParam) {
		// Original flow with gascId/userId - allow direct connection (NO Xano API call)
		logger.log(`🔗 Direct connection with gascId=${gascIdParam}, userId=${userIdParam}`);
		
		// Send params_connected for immediate connection (no validation)
		minecraftManager.sendCommand("/scriptevent daigon:wss_params_connected", clientId);
	}
	
	socket.on('message', (packet: WebSocket.RawData) => {
		try {
			
			const message = JSON.parse(packet.toString());
            if( gascId2 !== 0 && userId2 !== 0 && (isJSON(message) || packet.toString().includes("hud:score"))) {
                if(true){
                const outer = JSON.parse(message.body.message);
                if(outer != null  && outer.rawtext != null) {
                    const rawText = outer.rawtext[0].text;
					if(rawText.includes("hud:score:")){
                    	const innerString = rawText.replace(/^hud:score:/, "");
                    	loggedIn2 = message.body.receiver;
						const inner = JSON.parse(innerString);
                    	if(inner != null){
                        	sendToXano(inner);
                    	}
					}
            }
        }} 
			logger.log(`📨 From MC client ${clientId}:`, JSON.stringify(message, null, 2));
			minecraftManager.processMessage(clientId, message);
		 
		}catch (error) {
			logger.error(`Error parsing message from MC client ${clientId}:`, error);
		}
	});

	socket.on('close', () => {
		logger.log(`❌ Minecraft client disconnected: ${clientId}`);
		activePins.delete(sixDigitCode);
		minecraftManager.removeClient(clientId);
	});

	socket.on('error', (err: Error) => {
		// Log as warning instead of error to prevent crash - Minecraft sends non-standard close frames
		logger.log(`⚠️ Minecraft client ${clientId} socket error (handled): ${err.message}`);
		minecraftManager.updateClientStatus(clientId, 'inactive');
	});
});

minecraftWss.on('error', (err: Error) => {
	logger.error('Minecraft WebSocket server error:', err);
});

// Socket.IO Server (Web clients)
io.on('connection', (socket: SocketIOSocket) => {
	logger.log('🌐 Web client connected:', socket.id);

	const clientData = minecraftManager.getClientList();
	const connectedClients = clientData.clients.filter((c) => c.status === 'connected');

	// Send initial data
	socket.emit('clients_update', clientData);
	socket.emit('activity_history', minecraftManager.getActivityHistory(50));
	socket.emit('minecraft_status', {
		type: 'minecraft_status',
		connected: connectedClients.length > 0,
		serverInfo: connectedClients[0]
			? {
				address: connectedClients[0].address,
				port: connectedClients[0].port,
				connected: true
			}
			: {
				address: 'N/A',
				port: config.MINECRAFT_WS_PORT,
				connected: false
			},
		message:
			connectedClients.length > 0
				? `${connectedClients.length} Minecraft client(s) connected`
				: `No Minecraft clients connected - use /connect localhost:${config.MINECRAFT_WS_PORT} in game`
		});

	// Handle PIN validation from web clients
	socket.on('validate_pin', (data: { pin: string }) => {
		const pinEntry = activePins.get(data.pin);

		if (!pinEntry) {
			socket.emit('pin_validation_result', {
				success: false,
				message: 'Invalid PIN or PIN has expired'
			});
			return;
		}

		if (pinEntry.isUsed) {
			socket.emit('pin_validation_result', {
				success: false,
				message: 'PIN has already been used'
			});
			return;
		}

		// Mark PIN as used
		pinEntry.isUsed = true;

		// Send success message back to Minecraft
		const success = minecraftManager.sendCommand(
			`/scriptevent daigon:code_valid ${pinEntry.uuid}`,
			pinEntry.clientId
		);

		if (success) {
			logger.log(`✅ PIN ${data.pin} validated successfully for client ${pinEntry.clientId}`);
			socket.emit('pin_validation_result', {
				success: true,
				message: 'PIN accepted! Connection established.',
				clientId: pinEntry.clientId,
				uuid: pinEntry.uuid
			});

			// Optionally remove the PIN after successful use
			// activePins.delete(data.pin);
		} else {
			socket.emit('pin_validation_result', {
				success: false,
				message: 'Failed to communicate with Minecraft client'
			});
		}
	});

	// Handle commands from web clients
	socket.on('send_minecraft_command', (data: { command: string; targetClientId?: string }) => {
		const success = minecraftManager.sendCommand(data.command, data.targetClientId);
		socket.emit('command_result', {
			success,
			command: data.command,
			targetClientId: data.targetClientId
		});
	});

	socket.on('messageFromWebClient', (data: any) => {
		logger.log(`📨 Message from web client ${socket.id}:`, data);
	});

	socket.on('disconnect', () => {
		logger.log('🌐 Web client disconnected:', socket.id);
	});

	socket.on('error', (err: Error) => {
		logger.error('Socket.IO error for web client:', socket.id, err);
	});
});

// Express app
//app.use(handler);

// Start server
httpServer.listen(config.PORT, () => {
	logger.log(`HTTP server listening on port ${config.PORT}`);
	logger.log(`Main application: http://localhost:${config.PORT}`);
	logger.log(`Minecraft clients connect to: ws://localhost:${config.MINECRAFT_WS_PORT}`);
});

logger.log(`Minecraft WebSocket Bridge running on port: ${config.MINECRAFT_WS_PORT}`);

// Graceful shutdown
const gracefulShutdown = () => {
	logger.log('Initiating graceful shutdown...');

	httpServer.close(() => {
		logger.log('HTTP server closed.');
		minecraftWss.close(() => {
			logger.log('Minecraft WebSocket server closed.');
			io.close(() => {
				logger.log('Socket.IO server closed.');
				process.exit(0);
			});
		});
	});

	setTimeout(() => {
		logger.error('Graceful shutdown timed out. Forcing exit.');
		process.exit(1);
	}, 10000);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
