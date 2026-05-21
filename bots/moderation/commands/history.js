const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const config = require('../config.json');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('history')
        .setDescription('Показать историю наказаний пользователя')
        .addUserOption(option =>
            option.setName('пользователь')
                .setDescription('Пользователь, историю которого нужно показать')
                .setRequired(true)),
    async execute(interaction) {
        await interaction.deferReply({ ephemeral: false });

        const targetUser = interaction.options.getUser('пользователь');
        const logChannelId = config.logChannelId;

        if (!logChannelId) {
            return interaction.editReply('❌ Канал логов не настроен в конфиге.');
        }

        const logChannel = await interaction.guild.channels.fetch(logChannelId).catch(() => null);
        if (!logChannel) {
            return interaction.editReply('❌ Канал логов не найден на сервере.');
        }

        // Разрешённые действия (наказания)
        const allowedActions = [
            'Бан',
            'Мут',
            'Предупреждение',
            'Верификация (отказ)',
            'Автоматический мут'
        ];

        // Получаем последние 100 сообщений из канала логов
        let messages;
        try {
            messages = await logChannel.messages.fetch({ limit: 100 });
        } catch (error) {
            console.error('Ошибка при получении сообщений:', error);
            return interaction.editReply('❌ Не удалось получить сообщения из канала логов.');
        }

        const punishments = [];

        messages.forEach(msg => {
            if (msg.embeds.length === 0) return;
            const embed = msg.embeds[0];
            if (!embed.title || !embed.title.startsWith('📋 Модерация: ')) return;

            const action = embed.title.replace('📋 Модерация: ', '');
            if (!allowedActions.includes(action)) return;

            // Поле с целью
            const targetField = embed.fields?.find(f => f.name === '👤 Цель');
            if (!targetField) return;

            // Извлекаем ID цели из упоминания (формат: <@ID> или <@!ID>)
            const match = targetField.value.match(/<@!?(\d+)>/);
            if (!match) return;
            const targetId = match[1];

            if (targetId !== targetUser.id) return;

            // Поле с модератором
            const modField = embed.fields?.find(f => f.name === '🛡️ Модератор');
            const moderator = modField ? modField.value : 'Неизвестно';

            // Поле с деталями
            const detailsField = embed.fields?.find(f => f.name === '📝 Детали');
            const details = detailsField ? detailsField.value : '—';

            punishments.push({
                action,
                moderator,
                details,
                timestamp: msg.createdTimestamp
            });
        });

        if (punishments.length === 0) {
            return interaction.editReply(`📭 У пользователя **${targetUser.tag}** нет наказаний.`);
        }

        // Сортируем от новых к старым
        punishments.sort((a, b) => b.timestamp - a.timestamp);

        const maxDisplay = 15;
        const displayed = punishments.slice(0, maxDisplay);

        // Формируем текстовое описание
        let description = '';
        for (const p of displayed) {
            const date = new Date(p.timestamp).toLocaleString('ru-RU', {
                day: 'numeric',
                month: 'numeric',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });

            // Извлекаем чистый ID модератора для красивого упоминания
            const modMatch = p.moderator.match(/<@!?(\d+)>/);
            const modMention = modMatch ? `<@${modMatch[1]}>` : p.moderator;

            description += `**${date}** | **${p.action}**\n`;
            description += `👮 Модератор: ${modMention}\n`;
            description += `📌 ${p.details}\n\n`;
        }

        // Обрезаем, если слишком длинно
        if (description.length > 4096) {
            description = description.slice(0, 4093) + '...';
        }

        const embed = new EmbedBuilder()
            .setColor(0xFF0000)
            .setTitle(`📜 История наказаний: ${targetUser.tag}`)
            .setDescription(description)
            .setFooter({ text: `Всего записей: ${punishments.length} | Показано: ${displayed.length}` })
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
    }
};