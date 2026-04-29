# Лабораторна робота 4: Захищена комунікація у реальному часі

Розширення застосунку з лабораторної роботи №3: додано захищений **WebSocket-ендпоінт** з інтеграцією до **Binance Streaming API**, серіалізацією повідомлень у форматі **Protobuf** та перевіркою **OIDC-токена** при підключенні.

## Що реалізовано

- WSS-ендпоінт `/ws` на тому самому порту 443 (TLS 1.2, AES-GCM).
- Підключення до Binance `miniTicker` стріму для 5 пар: BTC, ETH, SOL, ADA, XRP.
- Protobuf-серіалізація всіх повідомлень (схема у `proto/messages.proto`).
- Перевірка `access_token` (HttpOnly cookie) через Casdoor `/api/userinfo` при кожному підключенні.
- Сесійна підписка: кожен клієнт отримує тільки ті монети, на які підписався.
- Авто-реконект до Binance при розриві з'єднання.
- Фронтенд: вибір монет, live-таблиця цін, WS-лог.

## Структура проєкту

```text
.
├── proto/
│   └── messages.proto     # Protobuf-схема (ClientMessage, PriceUpdate, ServerMessage)
├── casdoor-conf/
│   └── app.conf           # Конфігурація Casdoor
├── certs/
│   ├── server.crt         # TLS-сертифікат
│   └── v3.ext             # SAN-розширення
├── frontend/
│   └── index.html         # UI: OIDC + WebSocket crypto stream
├── nginx/
│   └── nginx.conf         # HTTPS proxy для Casdoor
├── docker-compose.yml     # MySQL, Casdoor, Nginx
├── package.json           # ws, protobufjs
├── server.js              # Node.js HTTPS/WSS сервер
├── .env.example
└── README.md
```

## Вимоги

- Node.js 18+
- Docker та Docker Compose

## Налаштування

```bash
cp .env.example .env
```

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

## Запуск

**1. Інфраструктура (Casdoor + MySQL):**

```bash
docker compose up -d
```

**2. Налаштуй Casdoor** (`http://localhost:8000`, admin/123456):
- Створи Application → скопіюй `client_id` та `client_secret` у `.env`
- Redirect URI: `https://localhost/callback`

**3. Встанови залежності та запусти сервер:**

```bash
npm install
sudo node server.js
```

Відкрий `https://localhost`, прийми self-signed сертифікат, залогінься через OIDC.

## Маршрути

| Метод | URL | Опис |
|-------|-----|------|
| `GET` | `/hello` | Тестовий endpoint |
| `GET` | `/login` | Старт OIDC flow |
| `GET` | `/callback` | OIDC callback |
| `GET` | `/user-info` | Захищений ресурс |
| `GET` | `/logout` | Вихід |
| `WSS` | `/ws` | Crypto price stream (потребує токен) |

## WebSocket протокол

Всі повідомлення серіалізуються у **Protobuf** (binary frames).

**Клієнт → Сервер** (`ClientMessage`):
```json
{ "symbols": ["BTCUSDT", "ETHUSDT"] }
```

**Сервер → Клієнт** (`ServerMessage`):
```json
{ "priceUpdate": { "symbol": "BTCUSDT", "price": "97500.12", "changePercent": "+2.34", "timestamp": "..." } }
```

## Корисні команди

```bash
docker compose logs -f casdoor   # логи Casdoor
docker compose down -v            # повний скид (видаляє дані MySQL)
node --check server.js            # перевірка синтаксису
```
