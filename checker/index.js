const TelegramBot = require('node-telegram-bot-api');
const SteamUser = require('steam-user');
const settings = require('./settings.json');

const bot = new TelegramBot(settings.botToken, { polling: true });
const tempAccountData = new Map();
const subscriptionCheckCache = new Map();
const CHANNEL_ID = -1002117297506;

const handleBotError = async (action) => {
    try {
        return await action();
    } catch (error) {
        if (error.code === 'ETELEGRAM' && error.response?.statusCode === 403) {
            console.log('Bot was blocked by user, skipping...');
            return null;
        }
        throw error;
    }
};

const sendMessage = async (chatId, text, options = {}) => {
    return await handleBotError(() => bot.sendMessage(chatId, text, options));
};

const editMessage = async (text, options) => {
    return await handleBotError(() => bot.editMessageText(text, options));
};

const deleteMessage = async (chatId, messageId) => {
    return await handleBotError(() => bot.deleteMessage(chatId, messageId));
};

const messages = {
    chooseMethod: 'Выберите метод проверки:',
    enterLogin: 'Введите логин:',
    enterPassword: 'Введите пароль:',
    checking: '⏳ Проверка...',
    sendAccounts: 'Отправьте аккаунты в формате:\nлогин1:пароль1\nлогин2:пароль2',
    valid: '✅ Валидный',
    steamGuard: '❌ Защищен Steam Guard',
    invalidPassword: '❌ Неверный пароль',
    tooMuchTraffic: '❌ Слишком много трафика',
    timeout: '❌ Время ожидания истекло',
    subscribeNeeded: 'Для использования бота необходимо подписаться на канал'
};

const keyboards = {
    mainMenu: {
        inline_keyboard: [
            [{ text: 'Одиночная проверка', callback_data: 'check_single' }],
            [{ text: 'Массовая проверка', callback_data: 'check_mass' }]
        ]
    },
    backOnly: {
        inline_keyboard: [[{ text: 'Отмена', callback_data: 'back_to_menu' }]]
    },
    afterCheck: {
        inline_keyboard: [
            [{ text: 'Проверить ещё', callback_data: 'check_single' }],
            [{ text: 'Вернуться в меню', callback_data: 'back_to_menu' }]
        ]
    },
    afterMassCheck: {
        inline_keyboard: [
            [{ text: 'Проверить ещё', callback_data: 'check_mass' }],
            [{ text: 'Вернуться в меню', callback_data: 'back_to_menu' }]
        ]
    },
    subscription: {
        inline_keyboard: [
            [{ text: '📢 Подписаться', url: 'https://t.me/steambattle' }],
            [{ text: '🔄 Проверить подписку', callback_data: 'check_subscription' }]
        ]
    }
};

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

const checkSubscription = async (userId) => {
    try {
        const status = await bot.getChatMember(CHANNEL_ID, userId);
        return ['creator', 'administrator', 'member'].includes(status.status);
    } catch (error) {
        return false;
    }
};

const showSubscriptionMessage = async (chatId, messageId = null) => {
    if (messageId) {
        return await editMessage(messages.subscribeNeeded, {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: keyboards.subscription
        });
    }
    return await sendMessage(chatId, messages.subscribeNeeded, {
        reply_markup: keyboards.subscription
    });
};

const checkSingleAccount = async (login, password) => {
    const steamClient = new SteamUser();
    return new Promise((resolve) => {
        let isResolved = false;

        const cleanup = () => {
            if (!isResolved) {
                isResolved = true;
                steamClient.logOff();
            }
        };

        steamClient.logOn({
            accountName: login,
            password: password
        });

        steamClient.on('loggedOn', () => {
            cleanup();
            resolve({ login, status: messages.valid });
        });

        steamClient.on('steamGuard', () => {
            cleanup();
            resolve({ login, status: messages.steamGuard });
        });

        steamClient.on('error', (err) => {
            cleanup();
            let status;
            switch (err.eresult) {
                case 5:
                    status = messages.invalidPassword;
                    break;
                case 50:
                    status = messages.tooMuchTraffic;
                    break;
                case 84:
                    status = messages.steamGuard;
                    break;
                default:
                    status = `❌ Ошибка: ${err.message}`;
            }
            resolve({ login, status });
        });

        setTimeout(() => {
            cleanup();
            resolve({ login, status: messages.timeout });
        }, 10000);
    });
};

const processAccounts = async (accounts, chatId, messageId, bot) => {
    const results = [];
    let currentMessage = 'Результаты:\n\n';

    for (const line of accounts) {
        const [login, password] = line.split(':');
        if (login && password) {
            await editMessage(
                currentMessage + 'В работе...',
                {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: keyboards.backOnly
                }
            );

            const result = await checkSingleAccount(login.trim(), password.trim());
            results.push(result);

            currentMessage += `Логин: ${result.login}\nСтатус: ${result.status}\n\n`;
        }
    }

    await editMessage(
        currentMessage,
        {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: keyboards.afterMassCheck
        }
    );

    return results;
};

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    if (shouldCheckSubscription(userId)) {
        const isSubscribed = await checkSubscription(userId);
        updateSubscriptionCache(userId, isSubscribed);

        if (!isSubscribed) {
            await showSubscriptionMessage(chatId);
            return;
        }
    } else if (!subscriptionCheckCache.get(userId).status) {
        await showSubscriptionMessage(chatId);
        return;
    }

    await sendMessage(chatId, messages.chooseMethod, {
        reply_markup: keyboards.mainMenu
    });
});

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const userId = query.from.id;
    const data = query.data;

    if (data === 'check_subscription') {
        const isSubscribed = await checkSubscription(userId);
        updateSubscriptionCache(userId, isSubscribed);

        if (isSubscribed) {
            await editMessage(messages.chooseMethod, {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: keyboards.mainMenu
            });
        } else {
            await handleBotError(() =>
                bot.answerCallbackQuery(query.id, {
                    text: 'Вы не подписаны на канал',
                    show_alert: true
                })
            );
        }
        return;
    }

// In the callback query handler for 'check_single'
    if (data === 'check_single') {
        let currentMessageId = messageId;
        let userInput = {};

        const safeDeleteMessage = async (chatId, msgId) => {
            try {
                await deleteMessage(chatId, msgId);
            } catch (error) {
                console.log('Safe delete handled');
            }
        };

        const updateMessage = async (text, keyboard) => {
            try {
                const result = await sendMessage(chatId, text, {
                    reply_markup: keyboard
                });
                if (currentMessageId && currentMessageId !== messageId) {
                    await safeDeleteMessage(chatId, currentMessageId);
                }
                currentMessageId = result.message_id;
                return result;
            } catch (error) {
                console.log('Update message handled');
            }
        };

        const passwordListener = async (msg) => {
            if (msg.from.id !== userId) return;

            userInput.password = msg.text;
            await safeDeleteMessage(msg.chat.id, msg.message_id);
            await updateMessage(messages.checking, keyboards.backOnly);

            const result = await checkSingleAccount(userInput.login, userInput.password);
            await updateMessage(
                `Логин: ${result.login}\nСтатус: ${result.status}`,
                keyboards.afterCheck
            );

            userInput = {};
            bot.removeListener('message', passwordListener);
        };

        const loginListener = async (msg) => {
            if (msg.from.id !== userId) return;

            userInput.login = msg.text;
            await safeDeleteMessage(msg.chat.id, msg.message_id);

            await updateMessage(messages.enterPassword, keyboards.backOnly);
            bot.removeListener('message', loginListener);
            bot.once('message', passwordListener);
        };

        await updateMessage(messages.enterLogin, keyboards.backOnly);
        bot.once('message', loginListener);
    }


    if (data === 'check_mass') {
        const messageTracker = {
            id: Date.now(),
            getUniqueId() {
                this.id++;
                return this.id;
            }
        };

        const updateMassMessage = async (text, keyboard) => {
            const uniqueText = `${text}\n[ID:${messageTracker.getUniqueId()}]`;
            return await editMessage(uniqueText, {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: keyboard
            });
        };

        await updateMassMessage(messages.sendAccounts, keyboards.backOnly);

        const massCheckHandler = async (msg) => {
            if (msg.from.id !== userId || !msg.text) return;

            const accounts = msg.text.split('\n').filter(line => line.includes(':'));

            if (accounts.length === 0) {
                await updateMassMessage('Не найдено аккаунтов для проверки', keyboards.backOnly);
                return;
            }

            await deleteMessage(msg.chat.id, msg.message_id);

            let currentResults = 'Проверка аккаунтов:\n\n';
            for (const account of accounts) {
                const [login, password] = account.split(':').map(str => str.trim());
                if (login && password) {
                    await updateMassMessage(currentResults + '⏳ Проверяется: ' + login, keyboards.backOnly);
                    const result = await checkSingleAccount(login, password);
                    currentResults += `Логин: ${result.login}\nСтатус: ${result.status}\n\n`;
                }
            }

            await updateMassMessage(currentResults, keyboards.afterMassCheck);
        };

        bot.once('message', massCheckHandler);
    }

    else if (data === 'back_to_menu') {
        await editMessage(messages.chooseMethod, {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: keyboards.mainMenu
        });
    }
});

bot.on('polling_error', (error) => {
    if (error.code === 'ETELEGRAM') {
        console.log('Telegram API Error:', error.code);
        return;
    }
    console.error('Bot error:', error);
});

console.log('Bot started successfully!');
