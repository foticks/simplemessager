const socket = io(); // Подключение к серверу через Socket.io

let currentUser = null; // Текущий пользователь
let chatPartnerId = null; // С кем сейчас чатимся
let selectedAvatarFile = null; // Выбранный файл аватарки

// Переключение экранов
function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(screen => screen.classList.remove('active'));
    document.getElementById(screenId).classList.add('active');
}

// Регистрация пользователя
function register() {
    const userIdInput = document.getElementById('user-id');
    const userId = userIdInput.value.trim();
    const errorMsg = document.getElementById('error-message');
    
    errorMsg.innerText = '';

    if (!/^\d{6}$/.test(userId)) {
        errorMsg.innerText = "ID должен состоять из 6 цифр.";
        return;
    }
    
    const sum = userId.split('').reduce((a, b) => a + Number(b), 0);
    
    if (sum === 0) {
        errorMsg.innerText = "Сумма цифр должна быть больше 0.";
        return;
    }
    
    // Отправляем запрос на регистрацию
    const formData = new FormData();
    formData.append('userId', userId);
    if (selectedAvatarFile) {
        formData.append('avatar', selectedAvatarFile);
    }

    fetch('/register-with-avatar', {
        method: 'POST',
        body: formData
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            currentUser = data.user;
            updateUIAfterLogin();
            showScreen('chat-screen');
            loadUsers();
        } else {
            errorMsg.innerText = data.error || "Ошибка регистрации.";
        }
    })
    .catch(error => {
        console.error("Ошибка сети:", error);
        errorMsg.innerText = "Ошибка соединения с сервером.";
    });
}

// Обновление интерфейса после входа
function updateUIAfterLogin() {
   const nameElem = document.getElementById('user-name');
   const avatarElem = document.getElementById('user-avatar');
   
   nameElem.innerText = currentUser.username || `Пользователь_${currentUser.id}`;
   avatarElem.src = currentUser.avatar || 'default-avatar.png';
   
   document.getElementById('message-form').onsubmit = sendMessageHandler;
   setupSocketListeners();
   
   socket.emit('update_status', { id: currentUser.id, online: true });
   
   window.addEventListener("beforeunload", () => {
       socket.emit('update_status', { id: currentUser.id, online: false });
   });
}

// Отправка сообщения из формы чата
function sendMessageHandler(e) {
   e.preventDefault();
   const input = document.getElementById('message-input');
   const text = input.value.trim();

   if (!text || !chatPartnerId) return;

   const messageData = {
       sender_id: currentUser.id,
       receiver_id: chatPartnerId,
       text,
       timestamp: new Date().toISOString()
   };
   
   socket.emit('send_message', messageData);
   input.value = '';
   renderMessage(messageData); // Оптимистичный рендер
}

// Загрузка списка пользователей
function loadUsers() {
    socket.emit('get_users');
    
    socket.once('users_list', users => {
        const usersContainer = document.getElementById('users');
        usersContainer.innerHTML = '';

        users.forEach(user => {
            if (user.id !== currentUser.id) {
                const div = document.createElement('div');
                div.dataset.id = user.id;
                div.innerHTML = `
                    <img src="${user.avatar || 'default-avatar.png'}" alt="" style="width:30px; border-radius:50%; margin-right:10px;">
                    <strong>${user.username || `Пользователь_${user.id}`}</strong><br/>
                    <small>ID:${user.id} | ${user.online ? 'Онлайн' : 'Оффлайн'}</small>
                `;
                div.style.cursor = 'pointer';
                div.style.padding = '8px';
                div.style.borderBottom = '1px solid #eee';
                div.onclick = () => startChat(user.id);
                usersContainer.appendChild(div);
            }
        });
        
        if (chatPartnerId) loadMessages(chatPartnerId);
    });
}

// Начать/продолжить чат с выбранным пользователем
function startChat(userId) {
    chatPartnerId = userId;
    const messagesContainer = document.getElementById('messages');
    messagesContainer.innerHTML = '<p>Загрузка истории сообщений...</p>';
    loadMessages(userId);
}

// Загрузка истории сообщений
function loadMessages(otherId) {
    socket.emit('get_messages', { sender_id: currentUser.id, receiver_id: otherId });
    
    socket.once('messages_history', messages => {
        const messagesContainer = document.getElementById('messages');
        messagesContainer.innerHTML = '';
        
        messages.forEach(msg => renderMessage(msg));
        
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    });
}

// Отрисовка одного сообщения в окне чата
function renderMessage(msg) {
    const messagesContainer = document.getElementById('messages');
    const isMine = msg.sender_id === currentUser.id;
    
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message';
    
    messageDiv.innerHTML = `
        <div class="${isMine ? 'text' : 'text others'}">
            ${msg.text}<br/>
            <span class="meta">${new Date(msg.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
        </div>
    `;
    
    messagesContainer.appendChild(messageDiv);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Кастомизация профиля
function openProfileEditor() {
   const newName = prompt("Введите новое имя:", currentUser.username);
   
   if (newName !== null && newName.trim() !== '') {
       socket.emit('update_profile', { id: currentUser.id, username: newName.trim() });
       
       currentUser.username = newName.trim();
       document.getElementById('user-name').innerText = newName.trim();
       
       console.log("Имя изменено на:", newName);
   }
}

// Слушатели событий Socket.io (вынесены отдельно, чтобы не дублировались)
function setupSocketListeners() {
   socket.on('new_message', msg => renderMessage(msg));
   socket.on('users_list_update', () => loadUsers());
   socket.on('profile_updated', ({ id, username, avatar }) => {
       if (id === currentUser.id) return; 
       loadUsers(); 
   });
}


// --- Привязка событий к HTML элементам ---
document.getElementById('register-screen').querySelector('button').onclick = register;
document.getElementById('user-id').onkeypress = function(e) { if(e.key === 'Enter') register(); };
document.getElementById('chat-screen').querySelector('#user-name').onclick = openProfileEditor;


// --- НОВЫЙ КОД ДЛЯ ЗАГРУЗКИ АВАТАРА ---
document.getElementById('avatar-upload').onchange = function(event) {
    const file = event.target.files[0]; // Получаем выбранный файл
    if (file) {
        selectedAvatarFile = file; // Сохраняем его в переменную
        alert('Аватарка выбрана: ' + file.name);
    }
};