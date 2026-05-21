const { REST, Routes } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');
const { token, clientId } = require('./config.json');

const commands = [];
const commandsPath = path.join(__dirname, 'commands');
console.log('Путь к папке commands:', commandsPath);

if (!fs.existsSync(commandsPath)) {
    console.error('❌ Папка commands не найдена!');
    process.exit(1);
}

const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
console.log('Найденные файлы:', commandFiles);

for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    try {
        const command = require(filePath);
        if ('data' in command && 'execute' in command) {
            commands.push(command.data.toJSON());
            console.log(`✅ Команда "${command.data.name}" загружена.`);
        } else {
            console.log(`⚠️ [ПРОПУЩЕН] Файл ${file} не содержит "data" или "execute".`);
        }
    } catch (error) {
        console.error(`❌ Ошибка при загрузке файла ${file}:`, error.message);
    }
}

if (commands.length === 0) {
    console.error('❌ Нет команд для регистрации.');
    process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
    try {
        console.log(`Начата регистрация ${commands.length} команд...`);
        const data = await rest.put(Routes.applicationCommands(clientId), { body: commands });
        console.log(`✅ Успешно зарегистрировано ${data.length} команд.`);
    } catch (error) {
        console.error('❌ Ошибка регистрации:', error);
    }
})();