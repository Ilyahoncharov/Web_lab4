# Лабораторна робота 3: Web-система з OIDC-авторизацією

Проєкт демонструє роботу HTTPS web-застосунку з авторизацією через **Casdoor** за протоколом **OpenID Connect**. Користувач проходить login flow, застосунок отримує токени, зберігає їх у `HttpOnly` cookies та дозволяє отримати захищену інформацію про профіль.

## Основні можливості

- HTTPS-сервер на Node.js без додаткових npm-залежностей.
- Авторизація через Casdoor за OAuth2/OIDC authorization code flow.
- Зберігання `id_token` та `access_token` у захищених cookies.
- Захищений endpoint `/user-info`, який звертається до Casdoor `/api/userinfo`.
- Docker Compose інфраструктура для Casdoor, MySQL та Nginx reverse proxy.
- Секрети винесені в `.env`, а приклад конфігурації збережено в `.env.example`.

## Структура проєкту

```text
.
├── casdoor-conf/
│   └── app.conf           # Конфігурація Casdoor
├── certs/
│   ├── server.crt         # Локальний TLS-сертифікат
│   ├── server.key         # Приватний ключ, не комітити
│   └── v3.ext             # SAN-розширення для сертифіката
├── frontend/
│   └── index.html         # UI для login/logout/user-info
├── nginx/
│   └── nginx.conf         # HTTPS proxy для Casdoor
├── docker-compose.yml     # MySQL, Casdoor, Nginx
├── server.js              # Node.js HTTPS застосунок
├── .env.example           # Приклад змінних середовища
└── README.md
```

## Вимоги

- Node.js 18 або новіше.
- Docker та Docker Compose.
- Браузер з можливістю прийняти локальний self-signed сертифікат.

## Налаштування змінних середовища

Створи локальний файл `.env` на основі прикладу:

```bash
cp .env.example .env
```

Заповни значення:

```env
MYSQL_ROOT_PASSWORD=change-me
MYSQL_DATABASE=casdoor

OIDC_ISSUER=http://localhost:8000
OIDC_CLIENT_ID=your-casdoor-client-id
OIDC_CLIENT_SECRET=your-casdoor-client-secret
OIDC_REDIRECT_URI=https://localhost/callback
OIDC_SCOPE=openid profile email

TLS_KEY_PATH=./certs/server.key
TLS_CERT_PATH=./certs/server.crt
```

Файл `.env` містить секрети та не повинен потрапляти в репозиторій.

## Запуск Casdoor

Підніми інфраструктуру:

```bash
docker compose up -d
```

Після запуску будуть доступні:

- Casdoor: `http://localhost:8000`
- Casdoor через Nginx HTTPS proxy: `https://localhost:8443`
- MySQL: всередині Docker-мережі як `mysql:3306`

Перевірити стан контейнерів можна командою:

```bash
docker compose ps
```

## Налаштування Casdoor

У Casdoor потрібно створити або налаштувати application для OIDC:

- Redirect URI: `https://localhost/callback`
- Grant type: authorization code
- Scopes: `openid profile email`
- Client ID: значення для `OIDC_CLIENT_ID`
- Client secret: значення для `OIDC_CLIENT_SECRET`

Після цього внеси `client_id` та `client_secret` у локальний `.env`.

## Запуск Node.js застосунку

Сервер слухає порти `443` та `80`, тому на macOS/Linux може знадобитися запуск з правами адміністратора:

```bash
sudo node server.js
```

Після запуску відкрий:

```text
https://localhost
```

Якщо браузер попередить про self-signed сертифікат, дозволь перехід для локального тестування.

## Маршрути застосунку

| Метод | URL | Опис |
| --- | --- | --- |
| `GET` | `/` | Перенаправлення на frontend |
| `GET` | `/hello` | Тестовий endpoint лабораторної |
| `GET` | `/login` | Старт OIDC login flow |
| `GET` | `/callback` | Callback після авторизації |
| `GET` | `/user-info` | Захищений ресурс з даними користувача |
| `GET` | `/logout` | Очищення cookies та вихід |
| `GET` | `/frontend/index.html` | Головний інтерфейс |

## Безпека

- `OIDC_CLIENT_SECRET`, пароль MySQL та приватний TLS-ключ не зберігаються у відкритому вигляді в коді.
- `.env` доданий у `.gitignore`.
- `certs/*.key` доданий у `.gitignore`, щоб приватні ключі випадково не потрапили в Git.
- Токени зберігаються в `HttpOnly`, `Secure`, `SameSite=Strict` cookies.

## Корисні команди

Зупинити Docker-сервіси:

```bash
docker compose down
```

Переглянути логи Casdoor:

```bash
docker compose logs -f casdoor
```

Перевірити синтаксис Node.js файлу:

```bash
node --check server.js
```

Перевірити фінальну Docker Compose конфігурацію:

```bash
docker compose config
```

## Примітка щодо пароля MySQL

Якщо змінити `MYSQL_ROOT_PASSWORD` після першого запуску, існуючий Docker volume `mysql-data` залишиться зі старим паролем. Для повного скидання локальної БД потрібно зупинити контейнери та видалити volume:

```bash
docker compose down -v
docker compose up -d
```

Це видалить локальні дані MySQL, тому використовуй команду тільки для тестового середовища.
