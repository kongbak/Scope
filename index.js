const WebSocket = require("ws");
const express = require("express");
const fs = require("fs");
var https = require("https");
const { Console } = require("console");
const app = express();
const port = 80;

var gameSettings = {
  startOnReady: true,
  preStartCooldown: 5000,
  gameTimeMins: 7,
  defaultWeapon:"RK-45",
  startAmmo:"full",
  telemetry:false,
  dropAmmoOnReload:false,
};

var weaponDefinitions = [
  {
    name:"Pistol",
    description:"Single Shot Goodness",
    slotID:5,
    damage:10,
    maxLoadedAmmo:30,
    maxClips:5,
    behavior:{
      triggerMode: 0x01,
      rateOfFire: 20,
      muzzleFlashMode: 0x1,
      flashParam1: 1,
      flashParam2: 3,
      narrowIrPower: 125,
      wideIrPower: 30,
      muzzleLedPower: 255,
      motorPower: 18,
    },
  },
  {
    name:"RK-45",
    description:"Default Recoil Weapon",
    slotID:6,
    damage:8,
    maxLoadedAmmo:10,
    maxClips:9,
    behavior:{
      triggerMode: 0xFE,
      rateOfFire: 5,
      muzzleFlashMode: 0x1,
      flashParam1: 4,
      flashParam2: 3,
      narrowIrPower: 80,
      wideIrPower: 0,
      muzzleLedPower: 255,
      motorPower: 18,
    },
  }
];

var game = {
  state: "waiting",
};

var mainTimer = null;
var gameEndTime = null;
var users = [];
var players = [];
var socketCounter = 0;
game.id = makeUID(6);
console.log("Game id:", game.id);

app.use(express.static("static"));

const httpsServer = https.createServer(
  {
    key: fs.readFileSync("server.key"),
    cert: fs.readFileSync("server.cert"),
  },
  app
);

const wss = new WebSocket.Server({ server: httpsServer });

httpsServer.listen(3000, () => {
  console.log("Listening at https://localhost/");
});

wss.on("connection", (ws) => {
  socketCounter = socketCounter + 1; // Increment socket counter
  ws.id = socketCounter; // Label this socket
  console.log("Websocket Connection | WSID:", ws.id);
  // Add user to the player list
  let user = {};
  user.socketID = socketCounter;
  users.push(user);
  if (game.state != "waiting") {
    sendToSID(ws.id, JSON.stringify({ msgType: "gameAlreadyStarted" }));
  }

  ws.on("message", (message) => {
    let command = JSON.parse(message);

    if (command.msgType == "init") {
      let index = getUIfromWSID(ws.id);
      users[index].clientType = command.client;
    } else if (command.msgType == "setUsername") {
      let index = getUIfromWSID(ws.id);
      users[index].username = command.username;
    } else {
      handleGameMessage(ws, command);
    }
    console.log(users);
  });
  ws.on("close", () => {
    let index = getUIfromWSID(ws.id);
    users.splice(index, 1);
    console.log("User Disconnected");
    updateLobbyList();
  });
});

function sendToSID(id, message) {
  let client = wss.clients.forEach((client) => {
    if (client.id == id) {
      client.send(message);
    }
  });
}

function getGroupFromUsers(group) {
  let sortedUserList = [];
  users.forEach((user) => {
    if (user.clientType == group) {
      sortedUserList.push(Object.assign({}, user));
    }
  });
  return sortedUserList;
}

function broadcast(message) {
  wss.clients.forEach((client) => {
    client.send(message);
  });
}

function getUIfromWSID(wsid) {
  let index = users.findIndex((user) => {
    return user.socketID == wsid;
  });
  return index;
}

function assignPlayersGunIDs() {
  let counter = 1;
  users.forEach((user) => {
    if (user.clientType == "player" && (user.state != undefined) ) {
      if(user.state == "ready") {
        user.gunID = counter;
        sendToSID(
          user.socketID,
          JSON.stringify({ msgType: "assignGunID", GunID: counter })
        );
        counter = counter + 1;
      }
    }
  });
}

function allPlayersReady() {
  let ready = true;
  getGroupFromUsers("player").forEach((player) => {
    if (player.state != undefined) {
      if (player.state != "ready") {
        ready = false;
      }
    }
  });
  return ready;
}

function startGame() {
  if (game.state == "waiting") {
    console.log("Starting Game...");
    game.state = "starting";
    assignPlayersGunIDs();
    broadcast(
      JSON.stringify({ "msgType": "updateGameSettings", "settings": gameSettings })
    );
    broadcast(
      JSON.stringify({ "msgType": "updateWeaponDefinitions", "weapons": weaponDefinitions })
    );
    updatePlayerList();
    broadcast(
      JSON.stringify({
        msgType: "updateGameState",
        state: "starting",
        cooldown: gameSettings.preStartCooldown,
      })
    );
    setTimeout(() => {
      game.state = "started";
      broadcast(
        JSON.stringify({ msgType: "updateGameState", state: "started" })
      );
      let currentTime = new Date();
      gameEndTime = new Date(currentTime.getDate() + (60000 * gameSettings.gameTimeMins));
      mainTimer = setTimeout(endGame, 60000 * gameSettings.gameTimeMins);
    }, gameSettings.preStartCooldown);
  } else {
    console.log("Game already started");
  }
}

function endGame() {
  broadcast(JSON.stringify({ msgType: "updateGameState", state: "ended" }));
  console.log("Game ended");
  game.state = "waiting";
}

function handleGameMessage(ws, message) {
  if (message.msgType == "getGameEndTime") {
    if (game.state == "started") {
      // get remaining battle time
      sendToSID(ws.id, JSON.stringify({ "msgType": "remainingTime", "time": gameEndTime }));
    }
  } else if (message.msgType == "setState") {
    let index = getUIfromWSID(ws.id);
    users[index].state = message.state;
    if (gameSettings.startOnReady == true) {
      if (allPlayersReady()) {
        console.log("All players are ready.");
        setTimeout(()=>{
          if( allPlayersReady() && (game.state == "waiting") ) {
            startGame();
          }
        }, 2000);
      }
    }
    updateLobbyList();
  } else if (message.msgType == "forceStartGame") {
    startGame();
  } else if (message.msgType == "kill") {
    let index = users.findIndex((user) => {
      return user.gunID == message.info.shooterID;
    });
    let killer = users[index].socketID;
    sendToSID(killer, JSON.stringify({ "msgType": "kill" }));
  }
}

function makeUID(length) {
  var result = "";
  var characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  var charactersLength = characters.length;
  for (var i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
  }
  return result;
}

function updateLobbyList() {
  let filteredPlayerList = [];

  users.forEach((user, i) => {
    if (user.state != undefined) {
      if (user.state == "lobby" || user.state == "ready") {
        let ready = false;
        if (user.state == "ready") {
          ready = true;
        }
        filteredPlayerList.push({
          username: user.username,
          id: user.socketID,
          ready: ready,
        });
      }
    }
  });

  broadcast(
    JSON.stringify({
      msgType: "lobbyListUpdated",
      players: filteredPlayerList,
    })
  );
}

function updatePlayerList() {
  let filteredPlayerList = [];

  users.forEach((user, i) => {
    if (user.state != undefined) {
      if (user.state == "ready") {
        filteredPlayerList.push({
          username: user.username,
          id: user.socketID,
          gunID:user.gunID
        });
      }
    }
  });

  broadcast(
    JSON.stringify({
      msgType: "playerListUpdated",
      players: filteredPlayerList,
    })
  );
}