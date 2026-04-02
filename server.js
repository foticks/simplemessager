// Импортируем необходимые модули
const express = require('express');
const http = require('http');
const path = require('path');
const { v4: uuidv4 } = require('uuid'); // Для генерации уникальных ID сообщений
const fileUpload = require('express-fileupload'); // Для загрузки файлов (аватарок)
const { Pool } = require('pg'); // Драйвер PostgreSQL

// Настройки подключения к PostgreSQL через переменную окружения
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Для бесплатного плана Railway
});

// Вспомогательные функции для работы с БД
async function getAllUsers() {
  const result = await pool.query('SELECT * FROM users');
  return result.rows;
}

async function getUserById(userId) {
  const result = await pool.query('SELECT * FROM users WHERE id=$1', [userId]);
  return result.rows[0];
}

async function registerNewUser(userId, username, avatar) {
  const result = await pool.query(
    'INSERT INTO users (id, username, avatar) VALUES($1, $2, $3)',
    [userId, username, avatar]
  );
  return result.rowCount > 0;
}

async function updateUserStatus(userId, online) {
  await pool.query('UPDATE users SET online=$1 WHERE id=$2', [online, userId]);
}

async function updateUserProfile(userId, username, avatar) {
  await pool.query(
    'UPDATE users SET username=$1, avatar=$2 WHERE id=$3',
    [username, avatar, userId]
  );
}

async function saveMessage(senderId, receiverId, text) {
  await pool.query(
    'INSERT INTO messages (sender_id, receiver_id, text) VALUES($1, $2, $3)',
    [senderId, receiverId, text]
  );
}

async function getMessagesBetweenUsers(senderId, receiverId) {
  const result = await pool.query(`
    SELECT *
    FROM messages
    WHERE (sender_id=$1 AND receiver_id=$2) OR (sender_id=$2 AND receiver_id=$1)
    ORDER BY timestamp ASC
  `, [senderId, receiverId]);
  return result.rows;
}

// Настройка приложения
const app = express();
const server = http.createServer(app);
const io = require("socket.io")(server);

// Порт берём из переменной окружения (Railway выставляет его автоматически)
const PORT = process.env.PORT || 3000;
const HOSTNAME = '0.0.0.0'; // Для Railway важен 0.0.0.0

// Настройки папок для аватарок
const AVATARS_DIR_NAME = 'avatars';
const AVATARS_PATH_RELATIVE_TO_PUBLIC = `/${AVATARS_DIR_NAME}`;
const AVATARS_ABSOLUTE_PATH_ON_DISK = path.join(__dirname, 'public', AVATARS_DIR_NAME);
const DEFAULT_AVATAR_PATH_RELATIVE_TO_PUBLIC = '/default-avatar.png';
const MAX_MESSAGE_HISTORY_LENGTH_PER_CHAT_PAIR = 50;

// Middleware
app.use(express.static(path.join(__dirname, 'public'))); // Статические файлы
app.use(express.json()); // Парсим JSON-тела запросов
app.use(express.urlencoded({ extended: true })); // Парсим URL-encoded тела (для форм)
app.use(fileUpload()); // Включаем обработку загрузки файлов

// Хранилища данных (сокеты)
let connectedSocketsMap = new Map(); // Сокет -> ID пользователя

// Запуск сервера
server.listen(PORT, HOSTNAME, () => {
  console.log(`Сервер запущен по адресу http://localhost:${PORT}`);
});

// Обработчики сокетов
io.on("connection", (socket) => {
  console.log(`Новое соединение ${socket.id}`);
  connectedSocketsMap.set(socket.id, null); // Пользователь еще не вошел

  socket.on("disconnect", () => {
    console.log(`Отключение ${socket.id}`);
    const userId = connectedSocketsMap.get(socket.id);
    connectedSocketsMap.delete(socket.id);
    if (!userId) return;
    // Обновляем статус пользователя на "оффлайн"
    updateUserStatus(userId, false);
    io.emit("status_updated", { id: userId, online: false });
  });

  // Регистрация через сокет (старый способ, оставлен для совместимости)
  socket.on("register", async ({ userId }) => {
    // Проверки ID...
    if (!/^\d{6}$/.test(userId)) return socket.emit("registration_result", { success: false, error: "Неверный формат ID" });
    const sumDigits = userId.split("").reduce((a,b)=>Number(a)+Number(b),0);
    if(sumDigits <= 0) return socket.emit("registration_result", { success: false, error: "Сумма цифр должна быть больше нуля" });
    const existingUser = await getUserById(userId);
    if (existingUser) return socket.emit("registration_result", { success: false, error: "ID уже занят" });

    const newUser = {
      id: userId,
      online: true,
      username: `Пользователь_${userId}`,
      avatar: DEFAULT_AVATAR_PATH_RELATIVE_TO_PUBLIC
    };
    await registerNewUser(userId, newUser.username, newUser.avatar);
    connectedSocketsMap.set(socket.id, userId);

    io.emit("users_list_update");
    socket.emit("registration_result", { success: true, user: newUser });
  });

  socket.on("get_users", async () => {
    const users = await getAllUsers();
    socket.emit("users_list", users);
  });

  socket.on("send_message", async ({ sender_id, receiver_id, text }) => {
    // Проверки ID остаются теми же самыми
    if(!sender_id || !receiver_id || !text || sender_id === receiver_id || !usersMap.has(sender_id) || !usersMap.has(receiver_id)){
      return;
    }

    // Сохраняем сообщение в БД
    await saveMessage(sender_id, receiver_id, text);

    // Получаем полное сообщение из БД (с ID и временем)
    const fullMessage = await getMessagesBetweenUsers(sender_id, receiver_id)[0];

    // Отправляем сообщение обоим пользователям
    io.to(getSocketIDFromUserID(receiver_id)).emit("new_message", fullMessage);
    io.to(getSocketIDFromUserID(sender_id)).emit("new_message", fullMessage);
  });

  socket.on("get_messages", async ({ sender_id, receiver_id }) => {
    const messages = await getMessagesBetweenUsers(sender_id, receiver_id);
    socket.emit("messages_history", messages);
  });

  socket.on("update_profile", async ({ id, username, avatar }) => {
    if(id && username && usersMap.has(id)){
      await updateUserProfile(id, username, avatar);
      io.emit("profile_updated", { id, username, avatar });
    }
  });

  socket.on("update_status", async ({ id, online }) => {
    if(id && typeof online === "boolean" && usersMap.has(id)){
      await updateUserStatus(id, online);
      io.emit("status_updated", { id, online });
    }
  });
});

// Вспомогательная функция для получения сокета по ID пользователя
function getSocketIDFromUserID(userId) {
  for (let [socketId, id] of connectedSocketsMap) {
    if (id === userId) return socketId;
  }
  return null;
}

// Обработчик регистрации с аватаркой
app.post('/register-with-avatar', async (req, res) => {
  const userId = req.body.userId;
  let avatarPath = DEFAULT_AVATAR_PATH_RELATIVE_TO_PUBLIC;

  if (req.files && req.files.avatar) {
    const avatarFile = req.files.avatar;
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const fileName = `avatar_${uniqueSuffix}${path.extname(avatarFile.name)}`;
    avatarFile.mv(path.join(AVATARS_ABSOLUTE_PATH_ON_DISK, fileName));
    avatarPath = `${AVATARS_PATH_RELATIVE_TO_PUBLIC}/${fileName}`;
  }

  // Проверки ID остаются теми же самыми
  if (!/^\d{6}$/.test(userId)) {
    return res.json({ success: false, error: "ID должен состоять из 6 цифр." });
  }

  const sumDigits = userId.split("").reduce((a,b)=>Number(a)+Number(b),0);
  if(sumDigits <= 0){
    return res.json({ success: false, error: "Сумма цифр должна быть больше нуля" });
  }

  // Проверяем, есть ли уже такой пользователь
  const existingUser = await getUserById(userId);
  if (existingUser) {
    return res.json({ success: false, error: "ID уже занят" });
  }

  // Регистрируем нового пользователя
  const registrationSuccess = await registerNewUser(userId, `Пользователь_${userId}`, avatarPath);

  if (registrationSuccess) {
    const newUser = await getUserById(userId); // Получаем свежесозданного пользователя
    io.emit("users_list_update"); // Обновляем список пользователей
    return res.json({ success: true, user: newUser });
  } else {
    return res.json({ success: false, error: "Ошибка регистрации" });
  }
});