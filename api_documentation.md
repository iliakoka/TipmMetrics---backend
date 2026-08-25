# TipMetrics Backend — API Documentation

## Base URL
```
https://tipmmetrics-backend-production.up.railway.app
```

---

## Authentication Header
Protected endpoints require:
```
Authorization: Bearer <accessToken>
```

---

## 1. Authentication Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| **POST** | `/auth/register` | ❌ | Register (`email`, `username`, `password`, `confirmPassword`) |
| **GET** | `/auth/verify-email?token=` | ❌ | Email verification link handler |
| **POST** | `/auth/login` | ❌ | Login with email OR username (`identifier`, `password`) |
| **POST** | `/auth/logout` | ✅ | Invalidate session / confirm logout |
| **GET** | `/auth/me` | ✅ | Get profile of logged-in user (`id`, `email`, `username`, `isVerified`) |
| **POST** | `/auth/forgot-password` | ❌ | Send 1-hour password reset email |
| **POST** | `/auth/reset-password` | ❌ | Set new password with reset token |

---

## 2. Tips & Predictions Endpoints (Core Product)

### `GET /tips/today`
Returns the automated top **5 to 7 tips** generated for today.
* Filtered to target odds range **1.65 – 2.15**
* Highest confidence score tip has `isFree: true` for the free teaser tier

**Sample Response:**
```json
[
  {
    "id": "7b8d8102-3c82-411a-8fc7-bcfe9d123e45",
    "matchDate": "2026-08-24T18:45:00.000Z",
    "leagueName": "Premier League",
    "homeTeamName": "Arsenal",
    "awayTeamName": "Chelsea",
    "homeTeamLogo": "https://media.api-sports.io/football/teams/42.png",
    "awayTeamLogo": "https://media.api-sports.io/football/teams/49.png",
    "market": "BTTS",
    "prediction": "Both Teams To Score: Yes",
    "odds": "1.78",
    "confidenceScore": "78.50",
    "isFree": true,
    "result": "PENDING",
    "resultScore": null,
    "factors": {
      "lambdaHome": 1.72,
      "lambdaAway": 1.34,
      "homeBttsRateLast10": 0.70,
      "awayBttsRateLast10": 0.60,
      "h2hBttsRate": 0.75,
      "modelProbability": 64.2,
      "impliedOddsProbability": 56.2
    }
  }
]
```

---

### `GET /tips/history`
Returns paginated past settled tips with their final outcome (`WON`, `LOST`, `VOID`) and verified match scores.

**Query Parameters:**
* `page` (default: 1)
* `limit` (default: 20)

**Sample Response:**
```json
{
  "total": 142,
  "page": 1,
  "limit": 20,
  "data": [
    {
      "id": "...",
      "homeTeamName": "Real Madrid",
      "awayTeamName": "Barcelona",
      "homeTeamLogo": "https://media.api-sports.io/football/teams/541.png",
      "awayTeamLogo": "https://media.api-sports.io/football/teams/529.png",
      "market": "OVER_2_5",
      "prediction": "Over 2.5 Goals",
      "odds": "1.85",
      "result": "WON",
      "resultScore": "2-1",
      "settledAt": "2026-08-23T23:30:15.000Z"
    }
  ]
}
```

---

### `GET /free-tip-test`
Returns the designated free teaser tip of the day formatted for landing page / banner display.

**Sample Response:**
```json
{
  "id": "7b8d8102-3c82-411a-8fc7-bcfe9d123e45",
  "date": "24.08.2026",
  "name": "Arsenal v. Chelsea",
  "homeTeam": "Arsenal",
  "awayTeam": "Chelsea",
  "homeTeamLogo": "https://media.api-sports.io/football/teams/42.png",
  "awayTeamLogo": "https://media.api-sports.io/football/teams/49.png",
  "league": "Premier League",
  "prediction": "Both Teams To Score: Yes",
  "odds": 1.78,
  "confidence": 78.5,
  "isFree": true
}
```

---

### `GET /tips/stats`
Returns live aggregate performance metrics and return on investment (ROI). Perfect for the landing page transparency widget!

**Sample Response:**
```json
{
  "totalTips": 142,
  "wonTips": 87,
  "lostTips": 55,
  "winRate": "61.27%",
  "averageOdds": "1.82",
  "profitUnits": "+16.34",
  "roi": "+11.51%",
  "marketStats": {
    "BTTS": { "total": 60, "won": 38, "winRate": "63.3%" },
    "OVER_2_5": { "total": 52, "won": 31, "winRate": "59.6%" },
    "HOME_WIN": { "total": 30, "won": 18, "winRate": "60.0%" }
  }
}
```

---

### Admin / Manual Triggers:
* `POST /tips/generate` — body: `{ "date": "2026-08-24" }` (Manual trigger to generate predictions)
* `POST /tips/settle` — body: `{ "date": "2026-08-24" }` (Manual trigger to sync scores & mark won/lost)
