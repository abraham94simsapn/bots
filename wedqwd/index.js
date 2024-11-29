const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const SteamUser = require('steam-user');
const settings = require('./settings.json');
const natural = require('natural');
const tokenizer = new natural.WordTokenizer();
const stringSimilarity = require('string-similarity');
const bot = new TelegramBot(settings.token, { polling: true });
const requestsFilePath = path.join(__dirname, 'requests.json');
const accountsFilePath = path.join(__dirname, 'acc.json');
const subscriptionCheckCache = new Map();
const userListeners = new Map();
const tempAccountData = new Map();
const userStates = new Map();
const aliases = JSON.parse(fs.readFileSync(path.join(__dirname, 'alias.json'), 'utf8'));
const messageDeleteQueue = new Set();

const safeDeleteMessage = async (chatId, messageId) => {
    const messageKey = `${chatId}_${messageId}`;
    if (messageDeleteQueue.has(messageKey)) return;

    messageDeleteQueue.add(messageKey);
    try {
        await bot.deleteMessage(chatId, messageId);
    } catch (error) {
        // Silently handle all deletion errors
    } finally {
        messageDeleteQueue.delete(messageKey);
    }
};
process.on('unhandledRejection', (error) => {
    console.log('Unhandled rejection handled:', error.message);
});

const checkLoginListener = async (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const messageId = messageHandlers.messageId;
    const login = msg.text;

    try {
        await safeDeleteMessage(msg.chat.id, msg.message_id);

        // Store login in temp data
        tempAccountData.set(userId, { login });

        const checkingText = '⏳ Проверяем логин...';
        await safeEditMessage(chatId, messageId, checkingText, {
            reply_markup: {
                inline_keyboard: [[{ text: 'Отмена', callback_data: 'manage_accounts' }]]
            }
        });

        const steamClient = new SteamUser();
        const result = await new Promise((resolve) => {
            let isResolved = false;

            steamClient.logOn({
                accountName: login,
                password: 'dummy_password_for_check'
            });

            steamClient.on('error', (err) => {
                if (!isResolved) {
                    isResolved = true;
                    steamClient.logOff();
                    if (err.eresult === 5) {
                        resolve({ status: 'Valid', message: 'Логин существует' });
                    } else {
                        resolve({ status: 'Error', message: 'Неверный логин' });
                    }
                }
            });

            setTimeout(() => {
                if (!isResolved) {
                    isResolved = true;
                    steamClient.logOff();
                    resolve({ status: 'Error', message: 'Время ожидания истекло' });
                }
            }, 10000);
        });

        if (result.status === 'Valid') {
            await safeEditMessage(chatId, messageId, 'Введите пароль:', {
                reply_markup: {
                    inline_keyboard: [[{ text: 'Отмена', callback_data: 'manage_accounts' }]]
                }
            });

            const checkPasswordListener = async (msg) => {
                const password = msg.text;
                await safeDeleteMessage(msg.chat.id, msg.message_id);

                await safeEditMessage(chatId, messageId, '⏳ Проверяем аккаунт...', {
                    reply_markup: {
                        inline_keyboard: [[{ text: 'Отмена', callback_data: 'manage_accounts' }]]
                    }
                });

                const accountResult = await checkAccount(login, password);
                let responseText = '';
                let keyboard = [];

                switch (accountResult.status) {
                    case 'Available':
                        responseText = '✅ Аккаунт доступен и работает';
                        keyboard = [[{ text: 'Назад', callback_data: 'manage_accounts' }]];
                        break;
                    case 'Steam Guard':
                        responseText = '⚠️ Аккаунт защищен Steam Guard';
                        keyboard = [[{ text: 'Попробовать другой', callback_data: 'check_accounts' }],
                            [{ text: 'Назад', callback_data: 'manage_accounts' }]];
                        break;
                    default:
                        responseText = `❌ ${accountResult.message}`;
                        keyboard = [[{ text: 'Попробовать снова', callback_data: 'check_accounts' }],
                            [{ text: 'Назад', callback_data: 'manage_accounts' }]];
                }

                await safeEditMessage(chatId, messageId, responseText, {
                    reply_markup: {
                        inline_keyboard: keyboard
                    }
                });
            };

            bot.once('message', checkPasswordListener);
            userListeners.set(userId, [checkPasswordListener]);
        } else {
            await safeEditMessage(chatId, messageId, `❌ ${result.message}`, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Попробовать снова', callback_data: 'check_accounts' }],
                        [{ text: 'Назад', callback_data: 'manage_accounts' }]
                    ]
                }
            });
        }

    } catch (error) {
        console.log('Check login error:', error.message);
        await safeEditMessage(chatId, messageId, 'Произошла ошибка при проверке аккаунта', {
            reply_markup: {
                inline_keyboard: [[{ text: 'Назад', callback_data: 'manage_accounts' }]]
            }
        });
    }
};

const editLoginListener = async (msg) => {
    if (msg.from.id !== userId) return;
    await safeDeleteMessage(msg.chat.id, msg.message_id);

    const login = msg.text;
    const accounts = JSON.parse(fs.readFileSync(accountsFilePath, 'utf8'));
    const account = accounts.find(acc => acc.login.toLowerCase() === login.toLowerCase());

    if (account) {
        await safeEditMessage(chatId, messageId,
            `Аккаунт найден:\nЛогин: ${account.login}\nПароль: ${account.pass}\nИгры: ${account.games.join(', ')}\n\nВыберите что редактировать:`, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Изменить логин', callback_data: `edit_login_${login}` }],
                        [{ text: 'Изменить пароль', callback_data: `edit_pass_${login}` }],
                        [{ text: 'Изменить игры', callback_data: `edit_games_${login}` }],
                        [{ text: 'Удалить аккаунт', callback_data: `delete_acc_${login}` }],
                        [{ text: 'Назад', callback_data: 'back_to_menu' }]
                    ]
                }
            });
    } else {
        await safeEditMessage(chatId, messageId, 'Аккаунт не найден!', {
            reply_markup: {
                inline_keyboard: [[{ text: 'Назад', callback_data: 'back_to_menu' }]]
            }
        });
    }
};

const gameListener = async (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const messageId = messageHandlers.messageId;
    const games = msg.text.split('\n').filter(game => game.trim());

    try {
        await safeDeleteMessage(msg.chat.id, msg.message_id);

        const accountData = tempAccountData.get(userId);
        accountData.games = games;

        await bot.editMessageText('Сохранить аккаунт?', {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: 'Да', callback_data: 'save_account' },
                        { text: 'Нет', callback_data: 'manage_accounts' }
                    ]
                ]
            }
        });
    } catch (error) {
        console.log('Game list handling error:', error.message);
    }
};


const loginListener = async (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const messageId = messageHandlers.messageId;
    const login = msg.text;

    try {
        await safeDeleteMessage(msg.chat.id, msg.message_id);

        // Store initial account data
        tempAccountData.set(userId, { login: login, games: [] });

        // Check for existing account
        const accounts = JSON.parse(fs.readFileSync(accountsFilePath, 'utf8'));
        const existingAccount = accounts.find(acc => acc.login.toLowerCase() === login.toLowerCase());

        if (existingAccount) {
            await safeEditMessage(
                chatId,
                messageId,
                `Аккаунт с логином "${login}" уже существует!\nЧто вы хотите сделать?`,
                {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: 'Редактировать', callback_data: `start_edit_${login}` }],
                            [{ text: 'Назад', callback_data: 'manage_accounts' }]
                        ]
                    }
                }
            );
            return;
        }

        // Proceed with new account creation
        const newText = 'Введите пароль:';
        const currentMessage = await bot.getChat(chatId);

        if (currentMessage?.text !== newText) {
            await safeEditMessage(chatId, messageId, newText, {
                reply_markup: {
                    inline_keyboard: [[{ text: 'Отмена', callback_data: 'manage_accounts' }]]
                }
            });
        }

        // Set up password listener
        bot.once('message', passwordListener);
        userListeners.set(userId, [passwordListener]);

    } catch (error) {
        console.log('Login handling error:', error.message);
        await safeEditMessage(chatId, messageId, 'Произошла ошибка при обработке логина', {
            reply_markup: {
                inline_keyboard: [[{ text: 'Назад', callback_data: 'manage_accounts' }]]
            }
        });
    }
};

if (!fs.existsSync(requestsFilePath)) {
    fs.writeFileSync(requestsFilePath, JSON.stringify([]));
}
if (!fs.existsSync(accountsFilePath)) {
    fs.writeFileSync(accountsFilePath, JSON.stringify([]));
}

const shouldCheckSubscription = (userId) => {
    const lastCheck = subscriptionCheckCache.get(userId);
    const now = Date.now();
    if (!lastCheck) return true;
    return (now - lastCheck.time) >= 15 * 60 * 1000;
};

const updateSubscriptionCache = (userId, isSubscribed) => {
    subscriptionCheckCache.set(userId, {
        status: isSubscribed,
        time: Date.now()
    });
};

const logAction = (userId, action, details = '') => {
    // Get username from userListeners or just use userId as fallback
    let username = userId;
    if (userListeners.has(userId)) {
        const userInfo = userListeners.get(userId);
        username = userInfo.username || userId;
    }
    console.log(`[${new Date().toISOString()}] User ${username}: ${action} ${details}`);
};

const showSubscriptionMessage = (chatId, messageId = null) => {
    const message = {
        text: 'Для использования бота необходимо подписаться на канал @steambattle',
        options: {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '📢 Подписаться', url: 'https://t.me/steambattle' }],
                    [{ text: '🔄 Проверить подписку', callback_data: 'check_subscription' }]
                ]
            }
        }
    };

    if (messageId) {
        return bot.editMessageText(message.text, {
            chat_id: chatId,
            message_id: messageId,
            ...message.options
        });
    }
    return bot.sendMessage(chatId, message.text, message.options);
};


const checkSubscription = async (userId) => {
    try {
        const status = await bot.getChatMember(settings.channel, userId);
        return ['creator', 'administrator', 'member'].includes(status.status);
    } catch (error) {
        logAction(userId, 'Subscription check error:', error.message);
        return false;
    }
};

const safeEditMessage = async (chatId, messageId, text, options = {}) => {
    try {
        await bot.editMessageText(text, {
            chat_id: chatId,
            message_id: messageId,
            ...options,
            parse_mode: 'HTML'
        });
    } catch (error) {
        if (!error.message.includes('message is not modified')) {
            console.log(`Edit message error: ${error.message}`);
        }
    }
};

// Your existing message handler with subscription check
bot.on('message', async (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;

    logAction(userId, 'Received message');

    try {
        if (msg?.message_id) {
            await safeDeleteMessage(chatId, msg.message_id);
        }
    } catch {}

    if (shouldCheckSubscription(userId)) {
        const isSubscribed = await checkSubscription(userId);
        updateSubscriptionCache(userId, isSubscribed);

        if (!isSubscribed) {
            logAction(userId, 'Subscription check failed');
            showSubscriptionMessage(chatId);
            return;
        }
    } else {
        const cachedStatus = subscriptionCheckCache.get(userId);
        if (!cachedStatus?.status) {
            logAction(userId, 'Using cached subscription status: Not subscribed');
            showSubscriptionMessage(chatId);
            return;
        }
    }

    const messageHandlers = userListeners.get(userId);
    if (messageHandlers && messageHandlers.length > 0) {
        const currentHandler = messageHandlers[0];
        currentHandler(msg);
    }
});

const messageHandlers = {
    chatId: null,
    messageId: null
};


const showRequestsPage = (requests, page = 0) => {
    const requestsArray = Array.isArray(requests) ? requests : [];
    const perPage = 5;
    const start = page * perPage;
    const end = start + perPage;
    const totalPages = Math.ceil(requestsArray.length / perPage);

    const requestsText = requestsArray
        .slice(start, end)
        .map(req => `От: ${req.user}\nЗаявка: ${req.request}`)
        .join('\n\n');

    const keyboard = [];
    if (totalPages > 1) {
        const navigationRow = [];
        if (page > 0) {
            if (page >= 5) {
                navigationRow.push({ text: '<<', callback_data: `page_${page-5}` });
            }
            navigationRow.push({ text: '<', callback_data: `page_${page-1}` });
        }
        navigationRow.push({ text: `${page + 1}/${totalPages}`, callback_data: 'current_page' });
        if (page < totalPages - 1) {
            navigationRow.push({ text: '>', callback_data: `page_${page+1}` });
            if (totalPages - page > 5) {
                navigationRow.push({ text: '>>', callback_data: `page_${page+5}` });
            }
        }
        keyboard.push(navigationRow);
    }
    keyboard.push([{ text: 'Назад', callback_data: 'admin_panel' }]);

    return {
        text: requestsText || 'Заявок нет',
        options: {
            reply_markup: {
                inline_keyboard: keyboard
            }
        }
    };
};


const showAccountsPage = (accounts, page = 0, currentUserId) => {
    const perPage = 5;
    const start = page * perPage;
    const end = start + perPage;
    const totalPages = Math.ceil(accounts.length / perPage);

    const accountsText = accounts
        .slice(start, end)
        .map(acc => {
            let text = `Логин: ${acc.login}\nПароль: ${acc.pass}\nИгры: ${acc.games.join(', ')}`;
            if (acc.addedBy) text += `\nДобавил: ${acc.addedBy}`;
            return text;
        })
        .join('\n\n');

    const keyboard = [];

    const isAdmin = settings.admins.includes(Number(currentUserId));
    const hasEditableAccounts = isAdmin || accounts.some(acc => acc.addedBy && acc.addedBy === currentUserId);

    if (hasEditableAccounts) {
        keyboard.push([{ text: 'Редактировать аккаунт', callback_data: 'edit_account' }]);
    }

    if (totalPages > 1) {
        const navigationRow = [];
        if (page > 0) {
            if (page >= 5) {
                navigationRow.push({ text: '<<', callback_data: `acc_page_${page-5}` });
            }
            navigationRow.push({ text: '<', callback_data: `acc_page_${page-1}` });
        }
        navigationRow.push({ text: `${page + 1}/${totalPages}`, callback_data: 'current_page' });
        if (page < totalPages - 1) {
            navigationRow.push({ text: '>', callback_data: `acc_page_${page+1}` });
            if (totalPages - page > 5) {
                navigationRow.push({ text: '>>', callback_data: `acc_page_${page+5}` });
            }
        }
        keyboard.push(navigationRow);
    }
    keyboard.push([{ text: 'Назад', callback_data: 'manage_accounts' }]);

    return {
        text: accountsText || 'Аккаунтов нет',
        options: {
            reply_markup: {
                inline_keyboard: keyboard
            }
        }
    };
};

const clearPreviousAction = (userId) => {
    if (userListeners.has(userId)) {
        const listeners = userListeners.get(userId);
        listeners.forEach(listener => bot.removeListener('message', listener));
        userListeners.delete(userId);
    }
    userStates.delete(userId);
};

const showMainMenu = (chatId, messageId = null) => {
    const menuButtons = [
        [{ text: 'Подать заявку', callback_data: 'submit_request' }],
        [{ text: 'Поиск аккаунтов', callback_data: 'search_accounts' }],
        [{ text: 'Проверка аккаунтов', callback_data: 'check_accounts' }],
        [{ text: 'Добавить аккаунт', callback_data: 'add_account' }]
    ];

    if (settings.admins.includes(chatId)) {
        menuButtons.push([{ text: 'Админ панель', callback_data: 'admin_panel' }]);
    }

    const message = {
        text: 'Выберите действие:',
        options: {
            reply_markup: {
                inline_keyboard: menuButtons
            }
        }
    };

    if (messageId) {
        return bot.editMessageText(message.text, {
            chat_id: chatId,
            message_id: messageId,
            ...message.options
        });
    }
    return bot.sendMessage(chatId, message.text, message.options);
};
const checkAccount = (login, password) => {
    return new Promise((resolve) => {
        const steamClient = new SteamUser();

        steamClient.logOn({
            accountName: login,
            password: password
        });

        // Immediately resolve with Steam Guard status when detected
        steamClient.on('steamGuard', () => {
            steamClient.logOff();
            resolve({ login: login, status: 'Steam Guard', message: 'Аккаунт защищен Steam Guard' });
        });

        steamClient.on('loggedOn', () => {
            steamClient.logOff();
            resolve({ login: login, status: 'Available', message: 'Аккаунт доступен' });
        });

        steamClient.on('error', (err) => {
            steamClient.logOff();
            let errorMessage = 'Ошибка при проверке';

            switch (err.eresult) {
                case 5:
                    errorMessage = '❌ Неверный пароль';
                    break;
                case 84:
                    errorMessage = '❌ Аккаунт защищен Steam Guard';
                    break;
                case 88:
                    errorMessage = '❌ Время ожидания истекло';
                    break;
                default:
                    errorMessage = `❌ Ошибка: ${err.message}`;
            }

            resolve({ status: 'Error', message: errorMessage });
        });


        // Timeout after 10 seconds
        setTimeout(() => {
            steamClient.logOff();
            resolve({ login: login, status: 'Timeout', message: 'Время ожидания истекло' });
        }, 10000);
    });
};

const passwordListener = async (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const messageId = messageHandlers.messageId;
    const password = msg.text;
    const accountData = tempAccountData.get(userId);

    try {
        await safeDeleteMessage(msg.chat.id, msg.message_id);

        const checkingText = '⏳ Проверяем аккаунт...';
        await safeEditMessage(chatId, messageId, checkingText, {
            reply_markup: {
                inline_keyboard: [[{ text: 'Отмена', callback_data: 'manage_accounts' }]]
            }
        });

        const steamClient = new SteamUser();
        const result = await new Promise((resolve) => {
            let isResolved = false;

            steamClient.logOn({
                accountName: accountData.login,
                password: password
            });

            steamClient.on('loggedOn', () => {
                if (!isResolved) {
                    isResolved = true;
                    steamClient.logOff();
                    resolve({ status: 'Available', message: 'Аккаунт доступен' });
                }
            });

            steamClient.on('steamGuard', () => {
                if (!isResolved) {
                    isResolved = true;
                    steamClient.logOff();
                    resolve({ status: 'Error', message: 'Аккаунт защищен Steam Guard' });
                }
            });

            steamClient.on('error', (err) => {
                if (!isResolved) {
                    isResolved = true;
                    steamClient.logOff();
                    let errorMessage;

                    switch (err.eresult) {
                        case 5:
                            errorMessage = 'Неверный пароль';
                            break;
                        case 50:
                            errorMessage = 'На аккаунте слишком большой трафик';
                            break;
                        case 84:
                            errorMessage = 'Аккаунт защищен Steam Guard';
                            break;
                        default:
                            errorMessage = `Ошибка: ${err.message}`;
                    }

                    resolve({ status: 'Error', message: errorMessage });
                }
            });

            setTimeout(() => {
                if (!isResolved) {
                    isResolved = true;
                    steamClient.logOff();
                    resolve({ status: 'Error', message: 'Время ожидания истекло' });
                }
            }, 10000);
        });

        if (result.status === 'Available') {
            accountData.pass = password;
            await safeEditMessage(chatId, messageId, 'Аккаунт рабочий ✅\nВведите список игр (каждая игра с новой строки):', {
                reply_markup: {
                    inline_keyboard: [[{ text: 'Отмена', callback_data: 'manage_accounts' }]]
                }
            });

            bot.once('message', gameListener);
            userListeners.set(userId, [gameListener]);
        } else {
            await safeEditMessage(chatId, messageId, `❌ ${result.message}\nВведите пароль повторно:`, {
                reply_markup: {
                    inline_keyboard: [[{ text: 'Отмена', callback_data: 'manage_accounts' }]]
                }
            });

            bot.once('message', passwordListener);
            userListeners.set(userId, [passwordListener]);
        }
    } catch (error) {
        console.log('Password handling error:', error.message);
        await safeEditMessage(chatId, messageId, 'Произошла ошибка при проверке аккаунта', {
            reply_markup: {
                inline_keyboard: [[{ text: 'Назад', callback_data: 'manage_accounts' }]]
            }
        });
    }
};


bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    clearPreviousAction(userId);

    const isSubscribed = await checkSubscription(userId);
    if (!isSubscribed) {
        showSubscriptionMessage(chatId);
        return;
    }
    await showMainMenu(chatId);
});

bot.on('callback_query', async (query) => {
    try {
        await bot.answerCallbackQuery(query.id);

        const chatId = query.message.chat.id;
        const userId = query.from.id;
        const data = query.data;
        const messageId = query.message.message_id;

        if (shouldCheckSubscription(userId)) {
            const isSubscribed = await checkSubscription(userId);
            updateSubscriptionCache(userId, isSubscribed);

            if (!isSubscribed) {
                logAction(userId, 'Subscription check failed');
                showSubscriptionMessage(chatId, messageId);
                return;
            }
        } else {
            // Get cached subscription status
            const cachedStatus = subscriptionCheckCache.get(userId);
            if (!cachedStatus?.status) {
                logAction(userId, 'Using cached subscription status: Not subscribed');
                showSubscriptionMessage(chatId, messageId);
                return;
            }
        }

        // Continue with your existing callback_query handling code
        await bot.answerCallbackQuery(query.id);

        if (data === 'check_subscription') {
            const isSubscribed = await checkSubscription(userId);
            if (!isSubscribed) {
                bot.answerCallbackQuery(query.id, { text: 'Вы не подписаны на канал!' });
                return;
            }
            showMainMenu(chatId, messageId);
            return;
        }

        // Check subscription before any action
        const isSubscribed = await checkSubscription(userId);
        if (!isSubscribed) {
            showSubscriptionMessage(chatId, messageId);
            return;
        }

        clearPreviousAction(userId);

        if (data === 'back_to_menu') {
            showMainMenu(chatId, messageId);
            return;
        }

        if (data === 'submit_request') {
            await bot.editMessageText('Напишите вашу заявку:', {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: {
                    inline_keyboard: [[{ text: 'Отмена', callback_data: 'back_to_menu' }]]
                }
            });

            const requestListener = async (msg) => {
                if (msg.chat.id !== chatId) return;

                // Delete user's message immediately
                await safeDeleteMessage(chatId, msg.message_id);

                const request = msg.text;
                const userId = msg.from.id;
                const username = msg.from.username || msg.from.first_name;

                const requests = JSON.parse(fs.readFileSync(requestsFilePath, 'utf8'));

                const isDuplicate = requests.some(req =>
                    req.userId === userId &&
                    req.request === request
                );

                if (!isDuplicate) {
                    requests.push({ user: username, userId, request });
                    fs.writeFileSync(requestsFilePath, JSON.stringify(requests, null, 2));

                    await bot.editMessageText(`✅ Заявка принята: ${request}`, {
                        chat_id: chatId,
                        message_id: messageId,
                        reply_markup: {
                            inline_keyboard: [[{ text: 'Назад', callback_data: 'back_to_menu' }]]
                        }
                    });
                } else {
                    await bot.editMessageText('❌ Такая заявка уже существует', {
                        chat_id: chatId,
                        message_id: messageId,
                        reply_markup: {
                            inline_keyboard: [[{ text: 'Назад', callback_data: 'back_to_menu' }]]
                        }
                    });
                }
            };

            bot.once('message', requestListener);
        }

        function findGameByAlias(searchQuery) {
            const normalizedQuery = searchQuery.toLowerCase().trim();

            for (const [gameName, gameAliases] of Object.entries(aliases)) {
                if (gameName.toLowerCase().includes(normalizedQuery) ||
                    gameAliases.some(alias => alias.toLowerCase() === normalizedQuery)) {
                    return gameName;
                }
            }
            return searchQuery;
        }

        function createGameMatcher(gameName) {
            // Common gaming abbreviations patterns
            const patterns = [
                // Full removal of spaces and special chars
                name => name.replace(/[^a-zA-Z0-9]/g, ''),
                // First letters of words
                name => name.split(/[\s-]+/).map(word => word[0]).join(''),
                // First letters + numbers
                name => name.replace(/[^a-zA-Z0-9]/g, '').replace(/([a-zA-Z])([a-zA-Z]*)/g, '$1')
            ];

            return patterns.map(pattern => pattern(gameName.toLowerCase()));
        }



        function normalizeGameName(gameName) {
            return gameName.toLowerCase()
                .replace(/[()[\]]/g, '') // Remove brackets
                .replace(/\d{4}/g, '')   // Remove year numbers
                .trim();
        }

        function findGameMatch(searchQuery, gameList) {
            const normalizedQuery = searchQuery.toLowerCase().replace(/[^\w\s]/g, '');

            return gameList.find(game => {
                const abbreviations = createGameAbbreviations(game);
                return abbreviations.some(abbr =>
                    abbr.includes(normalizedQuery) ||
                    normalizedQuery.includes(abbr)
                );
            });
        }

        if (data === 'search_accounts') {
            await bot.editMessageText('Введите название игры для поиска:', {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: {
                    inline_keyboard: [[{ text: 'Отмена', callback_data: 'back_to_menu' }]]
                }
            });

            const searchListener = async (msg) => {
                if (msg.chat.id !== chatId) return;
                await safeDeleteMessage(chatId, msg.message_id);

                const searchQuery = msg.text;
                const gameQuery = findGameByAlias(searchQuery);

                await bot.editMessageText('🔍 Ищем аккаунты...', {
                    chat_id: chatId,
                    message_id: messageId
                });

                try {
                    const accounts = JSON.parse(fs.readFileSync(accountsFilePath, 'utf8'));
                    const matchedAccounts = accounts.filter(account =>
                        account.games.some(game =>
                            game.toLowerCase() === gameQuery.toLowerCase() ||
                            findGameByAlias(game) === gameQuery
                        )
                    );

                    if (matchedAccounts.length > 0) {
                        // Get unique accounts by login
                        const uniqueAccounts = [...new Map(matchedAccounts.map(acc => [acc.login, acc])).values()];

                        // Check accounts until finding a working one
                        for (const acc of uniqueAccounts) {
                            const result = await checkAccount(acc.login, acc.pass);
                            if (result.status === 'Available') {
                                await bot.editMessageText(
                                    `Найден рабочий аккаунт с игрой "${gameQuery}":\n\nБиблиотека: ${acc.games.join(', ')}\nЛогин: ${acc.login}\nПароль: ${acc.pass}`, {
                                        chat_id: chatId,
                                        message_id: messageId,
                                        reply_markup: {
                                            inline_keyboard: [[{ text: 'Назад', callback_data: 'back_to_menu' }]]
                                        }
                                    }
                                );
                                return;
                            }
                        }

                        // If no working accounts found
                        await bot.editMessageText(`Рабочие аккаунты с игрой "${gameQuery}" не найдены.`, {
                            chat_id: chatId,
                            message_id: messageId,
                            reply_markup: {
                                inline_keyboard: [[{ text: 'Назад', callback_data: 'back_to_menu' }]]
                            }
                        });
                    } else {
                        await bot.editMessageText(`Аккаунты с игрой "${gameQuery}" не найдены.`, {
                            chat_id: chatId,
                            message_id: messageId,
                            reply_markup: {
                                inline_keyboard: [[{ text: 'Назад', callback_data: 'back_to_menu' }]]
                            }
                        });
                    }
                } catch (error) {
                    console.error('Search error:', error);
                    await bot.editMessageText('Произошла ошибка при поиске аккаунтов.', {
                        chat_id: chatId,
                        message_id: messageId,
                        reply_markup: {
                            inline_keyboard: [[{ text: 'Назад', callback_data: 'back_to_menu' }]]
                        }
                    });
                }
            };

            bot.once('message', searchListener);
        }

        function createGameAbbreviations(gameName) {
            const cleanName = gameName.toLowerCase().replace(/[^\w\s]/g, '');
            const words = cleanName.split(/\s+/);

            const abbreviations = new Set();

            // Add original name without special chars
            abbreviations.add(cleanName);

            // Add first letters of each word (e.g., "God of War" -> "gow")
            abbreviations.add(words.map(word => word[0]).join(''));

            // Add first letters + numbers (e.g., "Red Dead Redemption 2" -> "rdr2")
            const withNumbers = words.map(word =>
                /\d/.test(word) ? word : word[0]
            ).join('');
            abbreviations.add(withNumbers);

            // Remove year variations
            if (gameName.includes('2018')) {
                abbreviations.add(cleanName.replace('2018', '').trim());
            }

            return Array.from(abbreviations);
        }

        if (data === 'check_accounts') {
            messageHandlers.chatId = chatId;
            messageHandlers.messageId = messageId;

            await safeEditMessage(chatId, messageId, 'Введите логин для проверки:', {
                reply_markup: {
                    inline_keyboard: [[{ text: 'Отмена', callback_data: 'back_to_menu' }]]
                }
            });

            const loginListener = async (msg) => {
                const userId = msg.from.id;
                const chatId = msg.chat.id;
                const messageId = messageHandlers.messageId;
                const login = msg.text;

                try {
                    await safeDeleteMessage(msg.chat.id, msg.message_id);

                    // Store initial account data
                    tempAccountData.set(userId, { login: login });

                    // Check for existing account
                    const accounts = JSON.parse(fs.readFileSync(accountsFilePath, 'utf8'));
                    const existingAccount = accounts.find(acc => acc.login.toLowerCase() === login.toLowerCase());

                    if (existingAccount) {
                        const keyboard = settings.admins.includes(Number(userId)) ?
                            [[{ text: 'Редактировать', callback_data: `start_edit_${login}` }],
                                [{ text: 'Назад', callback_data: 'manage_accounts' }]] :
                            [[{ text: 'Назад', callback_data: 'manage_accounts' }]];

                        await safeEditMessage(chatId, messageId,
                            `Аккаунт с логином "${login}" уже существует!`, {
                                reply_markup: {
                                    inline_keyboard: keyboard
                                }
                            });
                        return;
                    }

                    // Proceed with new account creation
                    const checkingText = '⏳ Проверяем аккаунт...';
                    await safeEditMessage(chatId, messageId, checkingText, {
                        reply_markup: {
                            inline_keyboard: [[{ text: 'Отмена', callback_data: 'manage_accounts' }]]
                        }
                    });

                    const steamClient = new SteamUser();
                    const result = await new Promise((resolve) => {
                        let isResolved = false;

                        steamClient.logOn({
                            accountName: login,
                            password: 'dummy_password_for_check'
                        });

                        steamClient.on('error', (err) => {
                            if (!isResolved) {
                                isResolved = true;
                                steamClient.logOff();
                                if (err.eresult === 5) {
                                    resolve({ status: 'Valid', message: 'Логин существует' });
                                } else {
                                    resolve({ status: 'Error', message: 'Неверный логин' });
                                }
                            }
                        });

                        setTimeout(() => {
                            if (!isResolved) {
                                isResolved = true;
                                steamClient.logOff();
                                resolve({ status: 'Error', message: 'Время ожидания истекло' });
                            }
                        }, 10000);
                    });

                    if (result.status === 'Valid') {
                        await safeEditMessage(chatId, messageId, 'Введите пароль:', {
                            reply_markup: {
                                inline_keyboard: [[{ text: 'Отмена', callback_data: 'manage_accounts' }]]
                            }
                        });

                        bot.once('message', passwordListener);
                        userListeners.set(userId, [passwordListener]);
                    } else {
                        await safeEditMessage(chatId, messageId, `❌ ${result.message}\nВведите логин повторно:`, {
                            reply_markup: {
                                inline_keyboard: [[{ text: 'Отмена', callback_data: 'manage_accounts' }]]
                            }
                        });

                        bot.once('message', loginListener);
                        userListeners.set(userId, [loginListener]);
                    }

                } catch (error) {
                    console.log('Login handling error:', error.message);
                    await safeEditMessage(chatId, messageId, 'Произошла ошибка при обработке логина', {
                        reply_markup: {
                            inline_keyboard: [[{ text: 'Назад', callback_data: 'manage_accounts' }]]
                        }
                    });
                }
            };

            bot.once('message', checkLoginListener);
            userListeners.set(userId, [checkLoginListener]);
        }

        if (data === 'admin_panel' && settings.admins.includes(Number(userId))) {
            bot.editMessageText('Админ панель:', {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Аккаунты', callback_data: 'manage_accounts' }],
                        [{ text: 'Просмотр заявок', callback_data: 'view_requests' }],
                        [{ text: 'Вернуться в меню', callback_data: 'back_to_menu' }]
                    ]
                }
            });
        }

        if (data === 'manage_accounts') {
            bot.editMessageText('Управление аккаунтами:', {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Добавить аккаунт', callback_data: 'add_account' }],
                        ...(settings.admins.includes(Number(userId)) ? [
                            [{ text: 'Список аккаунтов', callback_data: 'view_accounts' }]
                        ] : []),
                        [{ text: 'Назад', callback_data: settings.admins.includes(Number(userId)) ? 'admin_panel' : 'back_to_menu' }]
                    ]
                }
            });
        }

        if (data === 'add_account') {
            messageHandlers.chatId = chatId;
            messageHandlers.messageId = messageId;

            await bot.editMessageText('Введите логин нового аккаунта:', {
                chat_id: messageHandlers.chatId,
                message_id: messageHandlers.messageId,
                reply_markup: {
                    inline_keyboard: [[{ text: 'Отмена', callback_data: 'manage_accounts' }]]
                }
            });

            bot.once('message', loginListener);
            userListeners.set(userId, [loginListener]);
        }


        if (data.startsWith('start_edit_')) {
            const login = data.replace('start_edit_', '');
            const accounts = JSON.parse(fs.readFileSync(accountsFilePath, 'utf8'));
            const account = accounts.find(acc => acc.login === login);

            const canEdit = settings.admins.includes(Number(userId)) ||
                (account.addedBy && account.addedBy === userId);

            if (!canEdit) {
                await bot.editMessageText('У вас нет прав на редактирование этого аккаунта', {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: {
                        inline_keyboard: [[{ text: 'Назад', callback_data: 'back_to_menu' }]]
                    }
                });
                return;
            }

            await safeEditMessage(chatId, messageId,
                `Аккаунт найден:\nЛогин: ${account.login}\nПароль: ${account.pass}\nИгры: ${account.games.join(', ')}${account.addedBy ? '\nДобавил: ' + account.addedBy : ''}\n\nВыберите что редактировать:`, {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: 'Изменить логин', callback_data: `edit_login_${login}` }],
                            [{ text: 'Изменить пароль', callback_data: `edit_pass_${login}` }],
                            [{ text: 'Изменить игры', callback_data: `edit_games_${login}` }],
                            [{ text: 'Удалить аккаунт', callback_data: `delete_acc_${login}` }],
                            [{ text: 'Назад', callback_data: 'back_to_menu' }]
                        ]
                    }
                });
        }

        if (data === 'add_more_games' && settings.admins.includes(Number(userId))) {
            bot.editMessageText('Введите название игры:', {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: {
                    inline_keyboard: [[{ text: 'Отмена', callback_data: 'manage_accounts' }]]
                }
            });

            bot.once('message', gameListener);
            userListeners.set(userId, [gameListener]);
        }

        if (data === 'save_account' && tempAccountData.get(userId)) {
            const accountData = tempAccountData.get(userId);
            accountData.addedBy = userId; // Add user ID who added the account
            const accounts = JSON.parse(fs.readFileSync(accountsFilePath, 'utf8'));
            accounts.push(accountData);
            fs.writeFileSync(accountsFilePath, JSON.stringify(accounts, null, 2));

            await bot.editMessageText(`✅ Аккаунт ${accountData.login} успешно добавлен!\n\nХотите добавить еще один аккаунт?`, {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: {
                    inline_keyboard: [
                        [{ text: 'Добавить еще', callback_data: 'add_account' }],
                        [{ text: 'Вернуться к управлению', callback_data: 'manage_accounts' }]
                    ]
                }
            });
            tempAccountData.delete(userId);
        }


        if (data.startsWith('acc_page_')) {
            const page = parseInt(data.split('_')[2]);
            const accounts = JSON.parse(fs.readFileSync(accountsFilePath, 'utf8'));
            const { text, options } = showAccountsPage(accounts, page, userId);
            bot.editMessageText(text, {
                chat_id: chatId,
                message_id: messageId,
                ...options
            });
        }

        // Add these handlers inside your callback_query handler

        if (data === 'edit_account') {
            messageHandlers.chatId = chatId;
            messageHandlers.messageId = messageId;

            const accounts = JSON.parse(fs.readFileSync(accountsFilePath, 'utf8'));
            const editableAccounts = accounts.filter(acc => settings.admins.includes(Number(userId)) || (acc.addedBy && acc.addedBy === userId));

            if (editableAccounts.length === 0) {
                await bot.editMessageText('Нет аккаунтов, доступных для редактирования.', {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: {
                        inline_keyboard: [[{ text: 'Назад', callback_data: 'manage_accounts' }]]
                    }
                });
                return;
            }

            await safeEditMessage(chatId, messageId, 'Введите логин аккаунта для редактирования:', {
                reply_markup: {
                    inline_keyboard: [[{ text: 'Назад', callback_data: 'back_to_menu' }]]
                }
            });

            const editLoginListener = async (msg) => {
                const userId = msg.from.id;
                const chatId = messageHandlers.chatId;
                const messageId = messageHandlers.messageId;
                const login = msg.text;

                await safeDeleteMessage(msg.chat.id, msg.message_id);

            };

            bot.once('message', editLoginListener);
            userListeners.set(userId, [editLoginListener]);
        }


        if (data.startsWith('edit_pass_')) {
            const login = data.replace('edit_pass_', '');
            bot.editMessageText('Введите новый пароль:', {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: {
                    inline_keyboard: [[{ text: 'Назад', callback_data: 'back_to_menu' }]]
                }
            });

            userListeners.set(userId, [passwordListener]);
        }

        if (data.startsWith('edit_games_')) {
            const login = data.replace('edit_games_', '');
            bot.editMessageText('Введите список игр (каждая с новой строки):', {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: {
                    inline_keyboard: [[{ text: 'Назад', callback_data: 'back_to_menu' }]]
                }
            });

            const gamesListener = async (msg) => {
                if (msg.from.id !== userId) return;
                const newGames = msg.text.split('\n').filter(game => game.trim().length > 0);
                const accounts = JSON.parse(fs.readFileSync(accountsFilePath, 'utf8'));
                const accountIndex = accounts.findIndex(acc => acc.login === login);

                try {
                    await safeDeleteMessage(chatId, msg.message_id);
                } catch (error) {
                    logAction(userId, 'Message deletion failed - continuing');
                }

                if (accountIndex !== -1) {
                    accounts[accountIndex].games = newGames;
                    fs.writeFileSync(accountsFilePath, JSON.stringify(accounts, null, 2));

                    try {
                        await bot.editMessageText('✅ Список игр успешно обновлен!', {
                            chat_id: chatId,
                            message_id: messageId,
                            reply_markup: {
                                inline_keyboard: [[{ text: 'Назад', callback_data: 'back_to_menu' }]]
                            }
                        });
                    } catch (error) {
                        if (!error.message.includes('message is not modified')) {
                            logAction(userId, 'Message edit failed:', error.message);
                        }
                    }
                }
            };
            bot.once('message', gamesListener);
            userListeners.set(userId, [gamesListener]);
        }

        if (data.startsWith('delete_acc_')) {
            const login = data.replace('delete_acc_', '');
            bot.editMessageText(`Вы уверены, что хотите удалить аккаунт ${login}?`, {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: 'Да', callback_data: `confirm_delete_${login}` },
                            { text: 'Нет', callback_data: 'back_to_menu' }
                        ]
                    ]
                }
            });
        }

        if (data.startsWith('confirm_delete_')) {
            const login = data.replace('confirm_delete_', '');
            const accounts = JSON.parse(fs.readFileSync(accountsFilePath, 'utf8'));
            const filteredAccounts = accounts.filter(acc => acc.login !== login);
            fs.writeFileSync(accountsFilePath, JSON.stringify(filteredAccounts, null, 2));

            bot.editMessageText('✅ Аккаунт успешно удален!', {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: {
                    inline_keyboard: [[{ text: 'Назад', callback_data: 'back_to_menu' }]]
                }
            });
        }

        if (data === 'view_accounts') {
            const accounts = JSON.parse(fs.readFileSync(accountsFilePath, 'utf8'));
            const { text, options } = showAccountsPage(accounts, 0, userId);
            bot.editMessageText(text, {
                chat_id: chatId,
                message_id: messageId,
                ...options
            });
        }

        if (data === 'view_requests' && settings.admins.includes(Number(userId))) {
            const requests = JSON.parse(fs.readFileSync(requestsFilePath, 'utf8'));
            const { text, options } = showRequestsPage(requests, 0);
            bot.editMessageText(text, {
                chat_id: chatId,
                message_id: messageId,
                ...options
            });
        }

        if (data.startsWith('page_')) {
            const page = parseInt(data.split('_')[1]);
            const requests = JSON.parse(fs.readFileSync(requestsFilePath, 'utf8'));
            const { text, options } = showRequestsPage(requests, page);
            bot.editMessageText(text, {
                chat_id: chatId,
                message_id: messageId,
                ...options
            });
        }

    } catch (error) {
        console.error('Error in callback query:', error);
    }
});

// Error handlers
bot.on('polling_error', (error) => {
    console.log('Polling error:', error);
});

bot.on('error', (error) => {
    console.log('Bot error:', error);
});

console.log('Bot started successfully');
