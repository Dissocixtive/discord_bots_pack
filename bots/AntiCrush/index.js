const { Client, GatewayIntentBits, PermissionsBitField, Events } = require('discord.js');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// ------------------- ЗАГРУЗКА КОНФИГА -------------------
let config;
try {
    const configPath = path.join(__dirname, 'config.json');
    const configData = fs.readFileSync(configPath, 'utf8');
    config = JSON.parse(configData);
} catch (error) {
    console.error('❌ Не удалось загрузить config.json:', error.message);
    process.exit(1);
}

const {
    WHITELIST_USER_IDS,
    TARGET_ROLE_IDS,
    MAX_ROLES_ADDED_PER_UPDATE,
    TIME_WINDOW_MS,
    MAX_ROLES_IN_WINDOW,
    LOG_CHANNEL_NAME,
    TRACKED_AUDIT_ACTIONS,
    MAX_AUDIT_ACTIONS,
    AUDIT_TIME_WINDOW_MS
} = config;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildModeration
    ]
});

const roleAddTimestamps = new Map();
const auditActionTimestamps = new Map();

// ------------------- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ -------------------
function shouldApplyAntiCrash(member) {
    if (WHITELIST_USER_IDS.includes(member.id)) return false;
    const hasTargetRole = member.roles.cache.some(role => TARGET_ROLE_IDS.includes(role.id));
    return hasTargetRole;
}

async function stripAllRoles(member, reason) {
    // Не трогаем владельца сервера
    if (member.id === member.guild.ownerId) {
        console.log(`Попытка снять роли с владельца ${member.user.tag} – игнорируем.`);
        return;
    }
    // Не трогаем пользователей с правом ADMINISTRATOR
    if (member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        console.log(`Пользователь ${member.user.tag} имеет ADMINISTRATOR – роли не снимаем.`);
        return;
    }

    // Проверяем права бота на управление ролями
    const botMember = member.guild.members.cache.get(client.user.id);
    if (!botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        console.log(`❌ У бота нет права ManageRoles, не могу снять роли с ${member.user.tag}`);
        return;
    }

    // Определяем роли, которые нужно снять (исключаем @everyone и административные)
    const rolesToRemove = member.roles.cache.filter(role => 
        role.id !== member.guild.id &&
        !role.permissions.has(PermissionsBitField.Flags.Administrator)
    );

    if (rolesToRemove.size === 0) return;

    // Проверяем, что бот выше по иерархии ролей, чем снимаемые роли
    const highestBotRole = botMember.roles.highest;
    const rolesAboveBot = rolesToRemove.filter(role => role.comparePositionTo(highestBotRole) > 0);
    if (rolesAboveBot.size > 0) {
        console.log(`❌ Не могу снять роли ${rolesAboveBot.map(r => r.name).join(', ')} у ${member.user.tag} – они выше роли бота`);
        return;
    }

    try {
        await member.roles.remove(rolesToRemove);
        console.log(`Сняты все роли (${rolesToRemove.size}) с ${member.user.tag} по причине: ${reason}`);

        // Логирование в канал, если указан
        if (LOG_CHANNEL_NAME) {
            const logChannel = member.guild.channels.cache.find(ch => ch.name === LOG_CHANNEL_NAME);
            if (logChannel && logChannel.isTextBased()) {
                await logChannel.send(`⚠️ **${member.user.tag}** лишён всех ролей.\nПричина: ${reason}`);
            }
        }
    } catch (error) {
        console.error(`Не удалось снять роли с ${member.user.tag}:`, error);
    }
}

// ------------------- ОТСЛЕЖИВАНИЕ МАССОВОЙ ВЫДАЧИ РОЛЕЙ -------------------
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
    if (!shouldApplyAntiCrash(newMember)) return;

    const addedRoles = newMember.roles.cache.filter(role => !oldMember.roles.cache.has(role.id));
    if (addedRoles.size === 0) return;

    // Проверка одномоментного добавления
    if (addedRoles.size >= MAX_ROLES_ADDED_PER_UPDATE) {
        await stripAllRoles(newMember, `одномоментно добавлено ${addedRoles.size} ролей`);
        return;
    }

    // Проверка частоты
    const userId = newMember.id;
    const now = Date.now();

    if (!roleAddTimestamps.has(userId)) roleAddTimestamps.set(userId, []);
    const timestamps = roleAddTimestamps.get(userId);
    for (let i = 0; i < addedRoles.size; i++) timestamps.push(now);

    const filtered = timestamps.filter(ts => now - ts < TIME_WINDOW_MS);
    roleAddTimestamps.set(userId, filtered);

    if (filtered.length >= MAX_ROLES_IN_WINDOW) {
        await stripAllRoles(newMember, `за последние ${TIME_WINDOW_MS / 1000} сек добавлено ${filtered.length} ролей`);
        roleAddTimestamps.delete(userId);
    }
});

// ------------------- ОТСЛЕЖИВАНИЕ МАССОВЫХ ИЗМЕНЕНИЙ СЕРВЕРА (АУДИТ-ЛОГ) -------------------
client.on(Events.GuildAuditLogEntryCreate, async (entry) => {
    const executor = entry.executor;
    if (!executor || executor.id === client.user.id) return;

    const member = await entry.guild.members.fetch(executor.id).catch(() => null);
    if (!member) return;
    if (!shouldApplyAntiCrash(member)) return;
    if (!TRACKED_AUDIT_ACTIONS.includes(entry.action)) return;

    const userId = executor.id;
    const now = Date.now();

    if (!auditActionTimestamps.has(userId)) auditActionTimestamps.set(userId, []);
    const timestamps = auditActionTimestamps.get(userId);
    timestamps.push(now);

    const filtered = timestamps.filter(ts => now - ts < AUDIT_TIME_WINDOW_MS);
    auditActionTimestamps.set(userId, filtered);

    if (filtered.length >= MAX_AUDIT_ACTIONS) {
        await stripAllRoles(member, `совершил ${filtered.length} отслеживаемых действий (${entry.action}) за последние ${AUDIT_TIME_WINDOW_MS / 1000} сек`);
        auditActionTimestamps.delete(userId);
    }
});

// ------------------- ЗАПРЕТ ССЫЛОК НА ДРУГИЕ DISCORD-СЕРВЕРА -------------------
const INVITE_REGEX = /(?:https?:\/\/)?(?:www\.)?(?:discord\.(?:gg|com\/invite)|discordapp\.com\/invite)\/([a-zA-Z0-9\-_]+)/i;

client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (!message.guild) return;
    if (!message.channel.permissionsFor(client.user).has(PermissionsBitField.Flags.ManageMessages)) return;

    if (INVITE_REGEX.test(message.content)) {
        try {
            await message.delete();

            // Отправляем предупреждение в личные сообщения
            try {
                await message.author.send(`${message.author}, запрещено отправлять приглашения на другие Discord-сервера!`);
            } catch (dmError) {
                console.log(`Не удалось отправить предупреждение в ЛС для ${message.author.tag}`);
            }
        } catch (error) {
            console.error('Не удалось удалить сообщение с инвайтом:', error);
        }
    }
});

// ------------------- ЗАПУСК БОТА -------------------
client.once(Events.ClientReady, () => {
    console.log(`✅ Бот ${client.user.tag} запущен и готов к работе!`);
    console.log(`📋 Белый список: ${WHITELIST_USER_IDS.length} пользователей`);
    console.log(`🎯 Целевые роли: ${TARGET_ROLE_IDS.length}`);
    if (LOG_CHANNEL_NAME) console.log(`📝 Лог-канал: ${LOG_CHANNEL_NAME}`);
    else console.log(`📝 Логирование в канал отключено`);
    console.log(`🔍 Отслеживаемые аудит-действия: ${TRACKED_AUDIT_ACTIONS.join(', ')}`);
    console.log(`⚙️ Порог аудит-действий: ${MAX_AUDIT_ACTIONS} за ${AUDIT_TIME_WINDOW_MS / 1000} сек`);
});

client.login(process.env.TOKEN);