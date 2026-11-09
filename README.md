# RouteMind AI

**Intelligent Route Planning, Traffic Prediction and Personalized Travel Recommendation System**

RouteMind AI compares real road routes between two places, predicts expected traffic with a trained scikit-learn model, scores the alternatives against the traveller's preference, and explains the recommendation in plain language. It is a MERN + Python (FastAPI) + ML + AI project that runs on **real services only** in normal use:

| Service | Real provider | Role |
|---|---|---|
| Database | **MongoDB Atlas** | Stores users, preferences and trips |
| Geocoding | **Nominatim** (OpenStreetMap) | Converts place names into coordinates |
| Road routing | **OSRM** (OpenStreetMap road data) | Real road routes: distance, duration, geometry, alternatives |
| Map | **Leaflet + OpenStreetMap tiles** | Displays the real OSRM geometry |
| Traffic prediction | **Project's own Python ML service** (RandomForest) | LOW / MEDIUM / HIGH prediction |
| Road tags & scenic POIs | **Overpass API** (OpenStreetMap data) | Only for the *Better Road Conditions* / *Better Scenery* preferences |
| AI | Optional LLM, or built-in rule-based engine | Understands text preferences, explains the choice |

> **Important clarifications**
> - **OSRM provides road routing, not live traffic.**
> - **Traffic prediction is produced by the project's Python ML model using the academic/demo dataset.** It is *not* live traffic data and the app does not claim real-time prediction.
> - **Road-condition and scenery results describe what is documented in OpenStreetMap** (surface/smoothness tags, nearby nature-related POIs). They are not measurements of pavement quality, safety or an official scenic rating (section 16a).
> - **OpenStreetMap provides map data.** **Nominatim converts location names into coordinates.** **MongoDB Atlas stores user and trip data.**

---

## Contents
1. [Problem statement](#1-problem-statement) · 2. [Objectives](#2-objectives) · 3. [Features](#3-features) · 4. [Architecture](#4-architecture) · 5. [Technology stack](#5-technology-stack) · 6. [Folder structure](#6-folder-structure)
7. [Setup: MongoDB Atlas](#7-mongodb-atlas-setup) · 8. [Nominatim](#8-nominatim-setup) · 9. [OSRM](#9-osrm-setup) · 10. [OpenStreetMap usage](#10-openstreetmap-usage)
11. [Environment variables](#11-environment-variables) · 12. [Running locally](#12-running-locally) · 13. [Docker](#13-docker)
14. [Python ML](#14-python-ml-explanation) · 15. [AI](#15-ai-explanation) · 16. [Route scoring](#16-route-scoring) (+ [16a: road conditions & scenery](#16a-better-road-conditions-and-better-scenery)) · 17. [API](#17-api-documentation)
18. [Failure behaviour](#18-failure-behaviour-no-fake-data) · 19. [Logging & diagnostics](#19-logging-and-diagnostics) · 20. [GitHub Actions](#20-github-actions) · 21. [Testing](#21-testing)
22. [Troubleshooting](#22-troubleshooting) · 23. [Security](#23-security) · 24. [Limitations](#24-limitations) · 25. [Future improvements](#25-future-improvements)

## 1. Problem statement
Map apps show "the fastest route", but travellers have different priorities: a family may want calm roads, a student the cheapest option. Raw distance/duration also ignores *when* you travel. RouteMind AI compares real route alternatives, predicts the traffic level for the chosen departure time, and recommends the route that best fits the user's stated and historical preferences.

## 2. Objectives
1. Geocode two places (Nominatim) and fetch real road routes with alternatives (OSRM).
2. Predict a traffic level per route with a trained ML classifier.
3. Convert base travel time into a traffic-adjusted time (configurable multipliers).
4. Score and rank routes 0–100 with preference-dependent weights; recommend one of the real routes.
5. Personalise lightly using the user's saved preferences and MongoDB trip history.
6. Interpret free-text preferences and explain recommendations (LLM optional, rule-based always available).
7. Persist users and trips in MongoDB Atlas; package with Docker and CI.

## 3. Features
Register/login (JWT + bcrypt) · explicit location lookup (no autocomplete) · interactive Leaflet map with every OSRM alternative, click-to-select · distance, duration, "via" road names · ML traffic prediction with class probabilities · adjusted travel time and rough cost · route score 0–100; **Better Road Conditions** and **Better Scenery** preferences with documented-OSM-tag road data and nearby nature-related POIs (clearly marked "unavailable" when the data is missing); a time limit ("not much longer") in the notes · **AI Recommended Route** with a "Why this route?" explanation · natural-language preferences · save/list/delete trips · profile preferences · developer diagnostics panel showing what actually ran.

## 4. Architecture

```
React (Vite) ──/api──▶ Node + Express (orchestration, auth, route scoring, AI layer)
                          │
                          ├──▶ Nominatim   place name → coordinates     (REAL, OpenStreetMap)
                          ├──▶ OSRM        coordinates → real road routes (REAL; road routing only, no live traffic)
                          ├──▶ Python FastAPI ML service   RandomForest traffic prediction + travel-time model
                          ├──▶ Overpass API  road surface tags + scenic POIs (REAL OpenStreetMap data; only when asked for)
                          ├──▶ Optional LLM (any OpenAI-compatible API) — preference parsing + explanation
                          └──▶ MongoDB Atlas   users, preferences, trips
```

**Who does what**

| Component | Responsibility |
|---|---|
| OSRM | **Real road routing** (distance, duration, geometry, alternatives) |
| Python ML | **Traffic prediction** (LOW/MEDIUM/HIGH + confidence) from the academic/demo dataset |
| AI | **User-preference understanding + explanation** (LLM if `AI_API_KEY` is set, else rule-based) |
| MongoDB Atlas | **User and trip persistence** |
| React | **User interface** (forms, Leaflet map, charts) |
| Node.js | **Backend orchestration** (geocode → route → ML → score → explain; auth; trips) |

**Request flow for "Find Best Route"**

`React → Node → Nominatim (coordinates) → OSRM (real routes) → Python ML (traffic per route) → Node scoring (weights + history) → recommendedRoute (one of the real OSRM routes) → AI explanation → React map/dashboard`

Route scoring lives in Node because it needs the user's preferences and trip history from MongoDB, the route data and the ML prediction.

## 5. Technology stack
React 19, Vite, Tailwind CSS 3, React Router, Axios, Leaflet/React-Leaflet, Recharts · Node.js 22, Express 5, Mongoose, JWT, bcryptjs, helmet, express-rate-limit · MongoDB Atlas · Python 3.11+, FastAPI, Pydantic v2, pandas, numpy, scikit-learn, joblib · Nominatim, OSRM, OpenStreetMap tiles · Docker, Docker Compose, nginx, GitHub Actions.

## 6. Folder structure
```
route-mind/
├── frontend/                React app (pages, components, nginx.conf, Dockerfile)
├── backend/
│   ├── src/
│   │   ├── server.js, app.js, config.js, log.js, diagnostics.js, utils.js
│   │   ├── controllers/     auth, routes, trips
│   │   ├── routes/          URL wiring + rate limits
│   │   ├── middleware/      auth (JWT), errors (requireDb, errorHandler)
│   │   ├── models/          User, Trip (Mongoose)
│   │   └── services/        db (Atlas), geocode (Nominatim), routing (OSRM), mlClient, scoring, ai, planner,
│   │                        overpass (OSM client), roadQuality, scenery
│   ├── scripts/             check.js (CI), verify-external.js (manual real-service test)
│   ├── tests/               unit.test.js, api.test.js, helpers/ (test-only mocks)
│   └── Dockerfile
├── ml-service/              FastAPI app, generate_dataset.py, train_model.py, data/, tests/, Dockerfile
├── docker-compose.yml       frontend + backend + ml-service (MongoDB is external: Atlas)
├── .env.example             template (no secrets) — copy to .env
├── .github/workflows/ci.yml
└── docs/VIVA.md
```
`backend/tests/helpers/` (mock Nominatim/OSRM/LLM, in-memory DB stand-in, `sandboxServer.js`) is used **only by automated tests / offline UI checks**. The normal app never imports it.

## 7. MongoDB Atlas setup
1. In MongoDB Atlas create a cluster (the free M0 tier is fine) and a **Database User** (Database Access → Add New Database User; password authentication).
2. **Network Access → Add IP Address**: add **your current public IP** (or "Add Current IP Address"). Atlas rejects connections from IPs that are not on the list — this is the most common cause of connection failures. Avoid `0.0.0.0/0` unless you understand the risk; if you demo from a different network, add that network's IP too.
3. Cluster → **Connect → Drivers** → copy the `mongodb+srv://…` string.
4. Put it in your local `.env` (never in source code, README or the frontend):
   ```
   MONGO_URI=mongodb+srv://<db_username>:<your_password>@cluster0.xxxxx.mongodb.net/?appName=Cluster0
   ```
   If the password contains special characters (`@ : / ? # %`), URL-encode them (`@` → `%40`).
5. Start the backend. You should see `[DATABASE] MongoDB connected successfully`. The URI is never printed.

Data lives in database `routemind` (`MONGO_DB_NAME`), collections `users` and `trips`.
There is **no in-memory fallback** in the normal app. If Atlas cannot be reached the backend logs *"Unable to connect to MongoDB Atlas. Check MONGO_URI and Atlas Network Access settings."*, keeps retrying every 10 s, and database routes answer **503 "Database unavailable"**. A missing or placeholder `MONGO_URI` stops the backend at startup with a clear message.

## 8. Nominatim setup
Nothing to install — the public service is used by default: `GEOCODE_URL=https://nominatim.openstreetmap.org/search`.
- Requests use `format=json&limit=1` (the Location search button uses up to 5 results) plus an optional `countrycodes`/`email`.
- The backend only calls Nominatim when the user **submits** something (search button / Enter / Find Best Route). There is **no autocomplete** and nothing is sent per keystroke.
- Nominatim's usage policy requires an identifying User-Agent: set `GEOCODE_USER_AGENT` (default `RouteMindAI/1.0`) and, if you like, `GEOCODE_EMAIL` as a contact. Do not put personal data in the repository — keep it in `.env`.
- Results are cached for 24 h and calls are throttled to ≤ 1 request per 1.1 s.
- Test it: `curl -A "RouteMindAI/1.0" "https://nominatim.openstreetmap.org/search?q=Chennai&format=json&limit=1"`

## 9. OSRM setup
Public demo server by default: `OSRM_URL=https://router.project-osrm.org` (light use only, no SLA — self-host OSRM for heavy use).
- The backend calls `/route/v1/driving/{lon},{lat};{lon},{lat}?alternatives=true&geometries=geojson&overview=full&steps=true` (longitude first!).
- It parses `distance` (m), `duration` (s), `geometry` (GeoJSON → Leaflet `[lat, lon]`), and uses `legs[].summary` / `steps` to show the main roads ("via …").
- **OSRM gives free-flow road routing only — no live traffic.** Alternatives are exactly what OSRM returns; none are invented. If OSRM returns one route, one route is shown.
- Test it: `curl "https://router.project-osrm.org/route/v1/driving/80.2707,13.0827;79.8083,11.9416?overview=false&alternatives=true"`

## 10. OpenStreetMap usage
Map tiles are loaded from `https://tile.openstreetmap.org/{z}/{x}/{y}.png` by Leaflet with the required attribution. The line drawn is the geometry returned by OSRM, so it follows real roads; origin/destination markers use Nominatim's coordinates. The public tile server is for light use — for production use a tile provider or your own tile server.

## 11. Environment variables
Copy `.env.example` → `.env` in the project root (the backend also reads `backend/.env`). `.env` is git-ignored.

| Variable | Required | Purpose |
|---|---|---|
| `MONGO_URI` | **yes** | MongoDB Atlas connection string (secret) |
| `MONGO_DB_NAME` | no (`routemind`) | Database name |
| `JWT_SECRET` | **yes** (prod) | Signs login tokens (secret). Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `GEOCODE_URL` | no | Nominatim `/search` URL |
| `GEOCODE_USER_AGENT` / `GEOCODE_EMAIL` | no | Identify your app to Nominatim |
| `GEOCODE_COUNTRY_CODES` | no | e.g. `in` |
| `OSRM_URL` | no | OSRM base URL |
| `ML_SERVICE_URL` | no (`http://localhost:8000`) | Python ML service |
| `ML_FALLBACK` | no (`on`) | `off` = fail instead of using the labelled rule-of-thumb when ML is down |
| `AI_API_KEY`, `AI_API_URL`, `AI_MODEL` | no | Optional LLM (any OpenAI-compatible endpoint). Empty key → rule-based AI |
| `COST_PER_KM`, `TOLL_PER_KM`, `TRAFFIC_MULTIPLIERS` | no | Cost / travel-time model |
| `OVERPASS_URLS` | no (4 public instances, see "Overpass endpoints and failover") | Comma-separated Overpass endpoints in priority order; failover moves down the list. Put your own instance first for heavy use |
| `OVERPASS_URL` | no (empty) | Legacy single endpoint; used only when `OVERPASS_URLS` is empty |
| `OVERPASS_USER_AGENT` | no (`GEOCODE_USER_AGENT`) | `User-Agent` sent to Overpass servers (add a contact, e.g. `RouteMindAI/1.0 (you@example.org)`) |
| `OVERPASS_TIMEOUT_MS`, `OVERPASS_BUDGET_MS`, `OVERPASS_MIN_INTERVAL_MS`, `OVERPASS_CACHE_TTL_MS`, `OVERPASS_COOLDOWN_MS` | no (20 s, 45 s, 1.1 s, 24 h, 30 s) | Timeout per HTTP attempt, total time allowed for road+scenery per search, gap between requests to the same endpoint, cache lifetime, "don't ask the same failed question again" time |
| `OVERPASS_RETRIES`, `OVERPASS_BACKOFF_MS` | no (1, 1 s) | Extra passes over endpoints that failed *fast* (5xx / network error) and the exponential backoff before them |
| `OVERPASS_ENDPOINT_COOLDOWN_MS`, `OVERPASS_ENDPOINT_COOLDOWN_MAX_MS` | no (30 s, 5 min) | How long a failing endpoint is skipped (doubles per consecutive failure; `Retry-After` honoured up to the max) |
| `ROAD_QUALITY`, `SCENERY` | no (`on`) | `off` disables the feature (it then reports "unavailable"; no Overpass calls) |
| `ROAD_SAMPLE_SPACING_M`, `ROAD_MAX_SAMPLES`, `ROAD_MATCH_RADIUS_M`, `ROAD_MIN_COVERAGE` | no (2000, 30, 25, 0.2) | Road-tag sampling (section 16a) |
| `SCENERY_NEAR_M`, `SCENERY_MAX_M`, `SCENERY_RING_WEIGHT`, `SCENERY_MAX_PER_CATEGORY`, `SCENERY_SATURATION_K`, `SCENERY_UNNAMED_FACTOR`, `SCENERY_MAX_CELLS`, `SCENERY_SIMPLIFY_TOL_M`, `SCENERY_MAX_POLY_POINTS` | no (300, 1000, 0.5, 5, 10, 0.5, 8, 50, 250) | Scenery proximity threshold, caps, score curve, query size (section 16a) |
| `DETOUR_DEFAULT_PERCENT`, `MAX_DETOUR_PERCENT` | no (15, 50) | Meaning of "not much longer"; safety limit for road/scenery preferences |
| `DIAGNOSTICS` | no | `on` enables `GET /api/diagnostics` (default on in development) |
| `CORS_ORIGIN`, `PORT` | no | Backend networking |

## 12. Running locally
Prerequisites: Node.js ≥ 20, Python ≥ 3.10, internet access, a MongoDB Atlas cluster (section 7).

```bash
cp .env.example .env            # then edit: real password in MONGO_URI, a random JWT_SECRET

# Terminal 1 — Python ML service
cd ml-service
python -m venv .venv && source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python generate_dataset.py && python train_model.py   # creates the demo dataset + trains + saves the model
uvicorn app.main:app --port 8000

# Terminal 2 — Node backend
cd backend
npm install
npm run verify:external         # optional: checks Atlas, Nominatim, OSRM and ML are really reachable
npm run dev                     # logs: [DATABASE] MongoDB connected successfully

# Terminal 3 — React frontend
cd frontend
npm install
npm run dev                     # http://localhost:5173
```

### Full demo scenario
1. Open http://localhost:5173 → **Create an account** → you land on the dashboard (login works the same way later).
2. **Route Planner**: Origin `Chennai`, Destination `Pondicherry` (press the search icon to pick the exact Nominatim match, or just type), preference **Low Traffic** → **Find Best Route**.
3. Check the results page: Leaflet map with real OSRM road geometry (click a line or card to switch alternatives), distance/duration, traffic prediction, score, **AI Recommended Route**, "Why this route?". Open **Developer diagnostics** to see which provider answered each step.
4. **Save Route A**.
5. Stop the backend (Ctrl-C) and start it again, log in, open **Trip History** — the trip comes back from MongoDB Atlas.
6. Optionally open `http://localhost:5000/api/health` and `http://localhost:5000/api/diagnostics`, and check the backend terminal for the `[GEOCODING]` `[ROUTING]` `[ML]` `[DATABASE]` log lines.

## 13. Docker
MongoDB is **not** containerised — Atlas is the database, so only three containers start.
```bash
cp .env.example .env            # set MONGO_URI (Atlas) and JWT_SECRET
docker compose up --build       # open http://localhost:8080
```
`ml-service` trains the model during its image build; `backend` waits for a healthy ML service; `frontend` is nginx serving the SPA and proxying `/api`. Configuration comes only from `.env` / environment variables — nothing secret is in `docker-compose.yml`. Remember Atlas Network Access must allow the IP your Docker host uses to reach the internet.

## 14. Python ML explanation
- **Task:** classify `traffic_level ∈ {LOW, MEDIUM, HIGH}`. **Model:** scikit-learn `RandomForestClassifier` in a one-hot `Pipeline`, saved with joblib; `train_model.py` loads → cleans → splits → trains → evaluates (accuracy, precision, recall, F1, confusion matrix, 5-fold CV) → saves.
- **Features:** `hour, day_of_week, weekend, distance, rain/weather, route_type, historical_traffic_level`. In the app: hour/day/weekend come from the chosen departure time, distance from the OSRM route, weather from the planner's weather selector (no weather API), `route_type` from the OSRM route's average speed (≥65 km/h highway, ≥45 mixed, else city), and `historical_traffic_level` from a training-set average per (road type, hour).
- **Dataset:** `ml-service/data/traffic_data.csv` — 2,000 **synthetic** rows from `generate_dataset.py`. *This dataset is used for academic demonstration and model development.* **Traffic prediction is based on the academic/demo training dataset and is not live traffic data.** Metrics (≈0.80 accuracy/F1 on the hold-out set) describe this synthetic data only.
- **Travel time:** OSRM free-flow time × multiplier (LOW 1.05, MEDIUM 1.20, HIGH 1.45; configurable).
- **Endpoints:** `GET /health`, `POST /predict-traffic` → `{"traffic_level":"HIGH","confidence":0.84,…}`, `/predict-traffic/batch`, `/predict-travel-time`, `/model-info` (Swagger UI at `:8000/docs`).
- **Test it:** `curl -X POST localhost:8000/predict-traffic -H "content-type: application/json" -d '{"hour":18,"day_of_week":4,"weekend":false,"distance":150,"rain":true}'`

## 15. AI explanation
1. **Preference understanding.** Text such as *"I'm travelling with my family and want to avoid heavy traffic"* becomes `trafficPriority=HIGH, comfortPriority=HIGH`; *"I want the cheapest route"* becomes `costPriority=HIGH`. With `AI_API_KEY` an OpenAI-compatible LLM does this (its JSON is validated against fixed enums); otherwise a keyword-based **rule-based parser** is used and the response is labelled `rule-based`.
2. **Explanation.** Generated from the *real* scored routes (differences in traffic, time, cost vs. the alternatives). LLM when a key exists, otherwise a deterministic template, labelled `rule-based`.
3. **Road conditions / scenery / time limits.** Requests such as *"I want better road conditions"*, *"prefer paved roads"*, *"a scenic route past beaches and parks"*, *"good roads and less traffic"*, *"scenic but don't want to travel much longer"* become structured priorities (`roadPriority`, `sceneryPriority`, `sceneryCategories`, a detour limit) which the backend scoring uses with real OSRM/OpenStreetMap data — see section 16a. The AI never supplies roads, POIs, traffic or route data.
4. The core routing and recommendation **never depend on an AI API**.

## 16. Route scoring
Per OSRM route the backend computes distance, base duration, predicted traffic, adjusted travel time, cost estimate and a **score 0–100**: time sub-score `100·fastest/this`, cost sub-score `100·cheapest/this`, traffic sub-score `100·(1 − expected congestion)`, combined with weights:

| Preference | Time | Traffic | Cost |
|---|---|---|---|
| FASTEST | 0.55 | 0.30 | 0.15 |
| CHEAPEST | 0.30 | 0.15 | 0.55 |
| LOW_TRAFFIC | 0.30 | 0.55 | 0.15 |
| BALANCED | ⅓ | ⅓ | ⅓ |

Text-derived priorities scale these weights; the user's last ≤10 MongoDB trip preferences are blended in (15 %, once ≥ 2 exist). `recommendedRoute` is always one of the real OSRM routes. Two further preferences and their data are described in section 16a.

## 16a. Better Road Conditions and Better Scenery

Two extra preferences, **Better Road Conditions** (`BETTER_ROADS`) and **Better Scenery** (`BETTER_SCENERY`), use a second real data source: **OpenStreetMap, read through the Overpass API**. They are computed **only when a search asks for them** (the preference, or a "Let AI decide" / notes request). The original preferences make no Overpass request and score exactly as before.

> **What the data can and cannot say.** OSRM returns road *names* and *manoeuvres*, not surface or condition. OpenStreetMap contributors *may* tag a road with `surface=*` and `smoothness=*`; many roads have neither tag. RouteMind therefore reports what is **documented in the map data**, never the physical state of the road. A road class such as "motorway" is a *classification*, not a pavement quality, and is **not** part of the score. Potholes, cracks and road safety are **not available** and are never claimed. Likewise "scenery" means *nature-related places mapped near the route*, not an official or measured scenic rating.

### Data investigated (what each source gives)
| Source | Used for | Finding |
|---|---|---|
| OSRM `route` + `steps` | Route geometry, road **names/refs** per step | No surface, smoothness or road class. `annotations=nodes` returns OSM node IDs, but the public server prints IDs above 9 digits in scientific notation (`1.10371441e+10`), so they are **corrupted** and cannot be used to look up ways. Names are used instead. |
| Overpass API (several public instances, configurable via `OVERPASS_URLS`) | `highway`, `surface`, `smoothness` tags of the ways driven; scenic POIs | Free, no key. Each public server is sometimes overloaded (HTTP 502/504, timeouts), so calls fail over to the next endpoint and, if all fail, fail cleanly — see "Overpass endpoints and failover" and "when data is unavailable". |

### Road-quality score (how it works)
1. **Sample** each OSRM route: one point per `ROAD_SAMPLE_SPACING_M` (2 km) of route, at most `ROAD_MAX_SAMPLES` (30) per route; each sample stands for its slice of the route length.
2. **One Overpass request** asks for the drivable `highway` ways inside a small box (± `ROAD_MATCH_RADIUS_M`, 25 m) around every sample (non-drivable values such as `construction`, `footway`, `proposed` are excluded).
3. **Match by name**: at each sample the way whose `name`, `name:en`, `alt_name` or `ref` equals the road name/ref OSRM reports for that part of the route is used (accents/case/spacing ignored: `NH 32` = `NH32`). A different street crossing the route is never used; an unnamed road is **not guessed** and stays *unknown*. If several ways match (e.g. two carriageways) the **least favourable documented** one is taken.
4. **Credit** per sample, from the way's tags only (an ordinal heuristic, *not* a measurement):

| Tag | Value → credit |
|---|---|
| `smoothness` (used first when present) | excellent 1.0 · good 0.85 · intermediate 0.6 · bad 0.35 · very_bad 0.15 · horrible 0.05 · very_horrible 0 · impassable 0 |
| `surface` (when no smoothness) | paved smooth (`asphalt, paved, chipseal, concrete, concrete:lanes, concrete:plates`) 0.75 · paved rough (`paving_stones, sett, cobblestone, bricks, …`) 0.5 · unpaved (`gravel, compacted, dirt, ground, sand, …`) 0.15 |
| neither tag / unrecognised value | **unknown → credit 0** (not "good", not "bad") |

   A paved surface is capped at 0.75, below `smoothness=good` (0.85), because "paved" says nothing about potholes. Multi-value tags (`asphalt;gravel`) use the worst recognised value.
5. **Score** = `100 × Σ(slice length × credit) / Σ(slice length)` → "documented quality points per route length" (0–100). **Coverage** = share of the sampled route whose way has a recognised `surface`/`smoothness` tag. Shown separately: documented paved %, unpaved %, unknown %, and the road classification mix (labelled *not a quality measure*), plus example OSM way links (`openstreetmap.org/way/ID`) so every claim can be checked.
6. The road axis is **used for ranking only if at least one route reaches `ROAD_MIN_COVERAGE` (20 %)**; otherwise every route shows **"Road quality data unavailable"** with the reason, the road weight is dropped and the other weights are renormalised.

*Limitations:* sampling (30 points per route) gives an estimate, not a full survey; OSM tags are volunteer-mapped, may be outdated, and are denser in some regions than others — so "unknown" is common in rural areas, and a route earns points only for what is documented.

### Scenery score (how it works)
1. **Candidates (Overpass request 1)** — whitelisted nature-related features in the map tiles the routes pass through (tile size grows so at most `SCENERY_MAX_CELLS` = 8 tiles are queried; absurdly long routes are reported as unavailable instead of overloading the server):

| Category | OSM tags | Relevance |
|---|---|---|
| Beach | `natural=beach` | 1.0 |
| Viewpoint | `tourism=viewpoint` | 1.0 |
| Nature reserve / national park | `leisure=nature_reserve`, `boundary=national_park` (named) | 0.9 |
| Lake or waterfall | `natural=water` (lake/reservoir/lagoon or untyped, **named**), `waterway=waterfall` | 0.8 / 0.9 |
| Park or garden | `leisure=park` (named) / `leisure=garden` (named) | 0.6 / 0.5 |
| Forest | `landuse=forest`, `natural=wood` (named) | 0.6 |
| Tourist attraction | `tourism=attraction` (named) — a generic tag, hence low | 0.3 |

   The relevance numbers are an **editorial choice** (how directly a feature type is about nature/views), not fitted or measured. Shops, restaurants and other urban POIs are **never queried**, so a dense city centre cannot score through unrelated POIs. Rivers and the coastline are not counted.
2. **Proximity to the route line** (not to the origin/destination): `SCENERY_NEAR_M` = 300 m → weight 1.0; up to `SCENERY_MAX_M` = 1000 m → weight `SCENERY_RING_WEIGHT` = 0.5; farther → ignored. Point features are measured exactly against the OSRM geometry. For areas (parks, lakes, forests) the bounding-box distance first discards POIs that are certainly too far, then **Overpass request 2** tests the real outline against the route; if that request fails the area is kept with a bounding-box distance and flagged **approximate**.
3. **Unique places only**: the same place mapped as node + polygon + relation (same category and name within 5 km, or anything of the same category within 200 m) counts once.
4. **No domination by volume**: only the best `SCENERY_MAX_PER_CATEGORY` (5) places per category count; unnamed viewpoints/beaches count × `SCENERY_UNNAMED_FACTOR` (0.5).
5. `points = Σ relevance × distance-weight` over the counted places; **score = 100 × (1 − e^(−points / K))**, `K = SCENERY_SATURATION_K` = 10. The saturating curve keeps the score in 0–100 and gives diminishing returns. If the user named categories ("beaches and parks") only those are queried and counted.
6. The results page lists every counted place (name, category, "within 300 m / 1 km", link to the OSM object) and draws them as green dots on the map. Wording is always *"N nature-related POIs near this route"*.

### Combining the new axes with the existing ones
All sub-scores are normalised to **0–100** before weighting (time = `100·fastest/this`, cost = `100·cheapest/this`, traffic = `100·(1 − expected congestion)`, road = road score, scenery = scenery score), so kilometres, minutes, rupees and POI points are never compared directly.

| Preference | Time | Traffic | Cost | Road | Scenery |
|---|---|---|---|---|---|
| FASTEST / CHEAPEST / LOW_TRAFFIC / BALANCED | unchanged (see section 16) | | | 0 | 0 |
| **BETTER_ROADS** | 0.20 | 0.20 | 0.10 | **0.50** | 0 |
| **BETTER_SCENERY** | 0.25 | 0.15 | 0.10 | 0 | **0.50** |

Why these numbers: the requested attribute gets half of the weight; the rest keeps the route practical, with time/traffic ahead of cost. They are design defaults, not fitted values. Rules around them:
- **Notes can add the axes to any preference** (e.g. "Fastest" + "I want a scenic drive"): a requested axis gets a final share of at least 0.40 (strongly requested) or 0.20; road + scenery together never exceed 0.80, so time/traffic/cost always keep a say. Time/traffic/cost priorities in the notes still scale their weights as before.
- **Trip-history personalisation** works as before (15 % blend), but a road/scenery weight that merely leaks in from history is removed unless this search asked for it.
- **Missing data**: an axis with no usable data for any route is dropped and the rest renormalised (`weightsDroppedForMissingData` in the response; the explanation and a warning say so).
- **Time limits**: "no more than 20 minutes longer", "within 10 % of the fastest" or a vague "don't want to travel much longer" (→ `DETOUR_DEFAULT_PERCENT`, 15 %) become a hard limit: slower routes are still scored and shown but cannot be the recommendation (the fastest route always qualifies). With no limit stated, road/scenery preferences still never recommend a route more than `MAX_DETOUR_PERCENT` (50 %) slower than the fastest.

### Let AI decide — new requests
The parser (rule-based, or the optional LLM with the same validated output) converts text into **structured priorities only** — `roadPriority`/`sceneryPriority` (NONE/MEDIUM/HIGH), `sceneryCategories`, a detour limit, plus the existing time/traffic/cost/comfort — and the backend scores real routes with them. The LLM is never asked for, and cannot supply, roads, POIs, traffic or route data; rule-based keyword hits are always honoured on top of LLM output.

| Notes | Result |
|---|---|
| "I want better road conditions." / "Prefer paved roads." | `BETTER_ROADS` |
| "I want a scenic route." | `BETTER_SCENERY` |
| "I would like to pass near beaches and parks." | `BETTER_SCENERY`, only beach + park POIs counted |
| "I want good road conditions and less traffic." | `BETTER_ROADS` with a raised traffic weight |
| "I want a scenic route but don't want to travel much longer." | `BETTER_SCENERY` + 15 % time limit |
| "smooth roads and a scenic drive, no more than 20 minutes longer" | road 0.40 + scenery 0.40 + 20-minute limit |
| "avoid potholes" / "safest roads" | `BETTER_ROADS` **and** a notice that potholes/safety are not available in the data |

### When data is unavailable
| Situation | What the user sees |
|---|---|
| **All** Overpass endpoints down / busy (429, 5xx) / timed out / returning an error page or a partial answer | Route cards say **"Road quality data unavailable"** and/or **"Scenery information unavailable"** with the reason; a warning explains that the recommendation uses only time, traffic and cost. Failures are remembered for `OVERPASS_COOLDOWN_MS` (30 s) and failing endpoints are skipped, so the public servers are not hammered. |
| Roads have no surface/smoothness tags (< 20 % coverage on every route) | Same "Road quality data unavailable" message; coverage is still shown. |
| Exact area test (request 2) fails | Scenery is shown but flagged **approximate**. |
| Enrichment exceeds `OVERPASS_BUDGET_MS` (45 s) | Treated as unavailable; the search still returns. |
| `ROAD_QUALITY=off` / `SCENERY=off` | Treated as unavailable; no Overpass calls. |
No substitute or invented data is ever shown.

### Overpass endpoints and failover
The public Overpass servers are run by volunteers and **each one is overloaded or down now and then**. In testing from inside the backend container, `overpass-api.de` answered HTTP 502 "at capacity" (and earlier HTTP 406), `overpass.kumi.systems` and `overpass.private.coffee` timed out or returned 502/504, while `overpass.openstreetmap.fr` answered 200 — and this changes from hour to hour. A single configured server therefore made Better Scenery fail often. RouteMind now uses an **ordered list of endpoints**:

```env
OVERPASS_URLS=https://overpass-api.de/api/interpreter,https://overpass.openstreetmap.fr/api/interpreter,https://overpass.kumi.systems/api/interpreter,https://overpass.private.coffee/api/interpreter
```

These four are the built-in default when nothing is configured. Use whole-planet instances only — a regional one such as `overpass.osm.ch` would silently return nothing outside its area. `OVERPASS_URL` (one endpoint) still works when `OVERPASS_URLS` is empty.

| Situation on one endpoint | What happens |
|---|---|
| Timeout (`OVERPASS_TIMEOUT_MS`), network error, HTTP 429, any 5xx, an HTML error page, a server-side "ran out of time" remark, or an HTTP 4xx other than 400 (e.g. 406 / 403: *that* server refuses us) | Try the **next endpoint** immediately. |
| HTTP 400 | Our query was rejected — every server would reject it, so it fails at once. |
| Any failure | The endpoint is skipped by later requests for `OVERPASS_ENDPOINT_COOLDOWN_MS` (30 s), **doubling per consecutive failure up to 5 min**; a `Retry-After` header is honoured up to that maximum. A success clears it. |
| Every endpoint failed, and some failed *fast* (5xx / network error) | At most `OVERPASS_RETRIES` (1) extra pass over just those, after an exponential backoff (`OVERPASS_BACKOFF_MS`: 1 s, 2 s, … with jitter). **Never** a retry after a timeout or a 429, and never beyond the time budget. |
| Every endpoint failed | An error → the existing honest *"Scenery information unavailable"* / *"Road quality data unavailable"* result. The same query is not sent again for `OVERPASS_COOLDOWN_MS`. |

**Cache and duplicates.** Successful answers are **cached for 24 h** (`OVERPASS_CACHE_TTL_MS`), keyed by the query itself and **not** by which server answered, so a repeated or overlapping route search sends no request at all. Identical queries made at the same moment share **one** in-flight request. Better Road Conditions uses the same client, so it benefits from the failover too; its scoring and response, like the scenery scoring and response, are unchanged.

### Overpass usage policy
Requests go through a throttle (`OVERPASS_MIN_INTERVAL_MS` ≥ 1.1 s between requests **to the same server**), carry an identifying `User-Agent` (`OVERPASS_USER_AGENT`, default `GEOCODE_USER_AGENT`; add a contact address), have a per-attempt timeout (`OVERPASS_TIMEOUT_MS`) and a shared deadline, are bounded (≤ 30 sample statements per route; ≤ 8 map tiles), and are cached for 24 h. A search that asks for both features sends one road request and two scenery requests (all to one server unless it fails); searches that ask for neither send none. Respect the [public instance policy](https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances): these servers are a shared courtesy, not a service level. For heavy or production use **run your own Overpass instance and put it first in `OVERPASS_URLS`**. Endpoints are configuration only — nothing secret is involved and nothing is sent from the browser.

**Limitations.** Failover only helps while *some* public server is up; if all are down or overloaded the feature honestly reports "unavailable" and nothing is invented. Servers may rate-limit by IP, so all users behind one backend share one quota. In the worst case (servers time out instead of answering quickly) a search can take up to `OVERPASS_BUDGET_MS` (45 s) before giving up on road/scenery. Different servers can lag slightly in map-data freshness, so the same query can return marginally different data depending on which one answered (the scoring rules are unaffected). The 24 h cache is in memory and is lost when the backend restarts.

### Saved routes
Saving a route stores, inside the existing `selectedRoute` object, an **optional, labelled snapshot** (`roadQuality`: score/coverage/paved/unpaved/unknown; `scenery`: score/count/top POI names; each with `source`, `snapshotAt` and a note that it is a snapshot of OpenStreetMap data, not a measurement or official rating). If the data was unavailable, only `{available:false}` is stored. Values are clamped server-side and way-level evidence is not persisted. Trips saved earlier simply lack these fields and still load; `BETTER_ROADS`/`BETTER_SCENERY` are valid trip and profile preferences.


## 17. API documentation
Errors are `{ "error": { "code", "message" } }`. Protected routes need `Authorization: Bearer <token>`.

| Method & path | Auth | Description |
|---|---|---|
| `GET /api/health` | – | `{backend, mongodb, mlService, routing, geocoding}` — mongodb/mlService reflect real state; routing/geocoding show "configured" (public servers are not pinged) |
| `GET /api/diagnostics` | – (dev) | Real per-service call counters (calls, cache hits, failures, last latency) and redacted configuration. No credentials |
| `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me`, `PUT /api/auth/preferences` | see code | Authentication and preferences |
| `GET /api/locations/search?q=` | – | Nominatim candidates |
| `POST /api/routes/search` | optional | `{origin, destination, date, time, preference, weather, notes}` (`preference`: `FASTEST, CHEAPEST, LOW_TRAFFIC, BALANCED, BETTER_ROADS, BETTER_SCENERY` or `AUTO`) → `{origin, destination, routes[], recommendedRoute, reason, weights{time,traffic,cost,road,scenery}, roadQuality{requested,available,reason}, scenery{…}, constraints, weightsDroppedForMissingData?, diagnostics, warnings, …}`; when requested each route also has `roadQuality{available,score,coverage,pavedShare,unpavedShare,unknownShare,classes[],evidence[],summary,source}` and `scenery{available,score,points,totalPois,pois[],summary,source,thresholds}` |
| `POST /api/ml/predict`, `GET /api/ml/info` | – | Proxy to the ML service |
| `POST/GET /api/trips`, `GET/DELETE /api/trips/:id` | ✔ | Trip persistence (owner only) |

Schemas — **User**: `name, email (unique), passwordHash (bcrypt), preferences{preferredMode, notes}, createdAt`; **Trip**: `userId, origin, destination, date, time, preference, selectedRoute{label,cost,traffic,via,geometry, roadQuality?, scenery?} (optional labelled snapshots, section 16a), distance, estimatedTime, trafficLevel, routeScore, explanation, createdAt`.

## 18. Failure behaviour (no fake data)
| Situation | What happens |
|---|---|
| OSRM unavailable | HTTP 503, **"Routing service unavailable. Please try again."** — no route is shown or invented |
| OSRM: no drivable route | HTTP 422 |
| OSRM returns one route | That one route is shown, with a notice — no generated alternatives |
| Nominatim unavailable | HTTP 503, **"Location service unavailable. Please try again."** — no substitute coordinates |
| Unknown place | HTTP 422 "We couldn't find …" |
| MongoDB unavailable | HTTP 503 **"Database unavailable."** — no in-memory fallback (route search still works anonymously) |
| ML service unavailable | By default a **clearly labelled** rule-of-thumb is used (`source: heuristic-fallback`) and the UI shows **"ML service unavailable — fallback prediction used."** Set `ML_FALLBACK=off` to fail instead |
| Overpass unavailable / no surface tags | **"Road quality data unavailable"** / **"Scenery information unavailable"** + reason; recommendation uses only time, traffic and cost (section 16a). Never invented |
| No `AI_API_KEY` / LLM error | Rule-based AI, labelled `rule-based` |

## 19. Logging and diagnostics
Backend logs show which real service handled each step, e.g. `[GEOCODING] Provider: Nominatim | Query: Chennai`, `[ROUTING] Routes received: 2`, `[ML] Model: RandomForest … Traffic: HIGH`, `[DATABASE] MongoDB connected successfully`, `[AI] Explanation generated by the rule-based engine`. A redaction layer masks `MONGO_URI`, the database password, the JWT secret and the AI key in everything that is logged; only URLs without credentials are printed. The **Developer diagnostics** panel on the results page and `GET /api/diagnostics` are built from counters recorded by the code that actually performs each call — nothing is hard-coded as "connected".

## 20. GitHub Actions
`.github/workflows/ci.yml` runs four jobs, none of which contact Nominatim, OSRM or Atlas: **frontend** (tests + build), **backend** (syntax/app check + tests; the API tests also run against a throw-away MongoDB service container via `MONGO_TEST_URI`, which refuses any non-local database), **ml-service** (generate data, train, pytest), **docker** (`docker compose build` with dummy values).

## 21. Testing
**Unit tests** (mocks allowed): `backend/tests/unit.test.js` (scoring, AI parser, helpers, schemas, MONGO_URI validation, secret redaction), `ml-service/tests/test_ml.py`, `frontend/tests/utils.test.js`.
**API integration tests** (mock Nominatim/OSRM/Overpass/LLM servers; in-memory DB stand-in unless `MONGO_TEST_URI` points to a *local* MongoDB): `backend/tests/api.test.js` — verifies the exact requests sent to Nominatim/OSRM, no-fake-data behaviour, the road-condition and scenery flows (documented tags, missing data, Overpass failures/retry/cache, duplicate POIs, proximity, notes parsing, combined priorities, saving and reloading), auth, trips, fallbacks, diagnostics. These prove the **code** behaves correctly; they do **not** prove that Atlas/Nominatim/OSRM are reachable.
**Manual external-service tests** (real services, your machine, your `.env`):
```bash
cd backend && npm run verify:external      # Atlas ping, Nominatim lookup, OSRM route, Overpass road tags + scenery POIs, ML prediction — prints PASS/FAIL, no secrets
curl http://localhost:5000/api/health      # then /api/diagnostics after a search
```
Run commands: `cd ml-service && python -m pytest -q` · `cd backend && npm test` · `cd frontend && npm test && npm run build`.

## 22. Troubleshooting
| Symptom | Fix |
|---|---|
| Backend exits: "MONGO_URI still contains the placeholder password" | Put your real Atlas database-user password into `.env` |
| "Unable to connect to MongoDB Atlas…" | Add your current IP in Atlas → Network Access; check the username/password (URL-encode special characters); check your internet connection |
| "Database unavailable" in the UI | Backend cannot reach Atlas right now (see backend log); it retries every 10 s |
| "Location service unavailable" | Nominatim blocked/rate-limited you or is down — wait a moment; avoid rapid repeated searches; check `GEOCODE_USER_AGENT` |
| "Routing service unavailable" | OSRM demo server busy/down — retry; for heavy use self-host OSRM |
| Banner "ML service unavailable — fallback prediction used" | Start the ML service (`uvicorn app.main:app --port 8000`) and check `ML_SERVICE_URL`; make sure `python train_model.py` was run |
| Blank map tiles | The browser cannot reach `tile.openstreetmap.org` |
| Login/Register says "Database unavailable" | Same as the Atlas items above |

## 23. Security
`.env` and `.env.*` are git-ignored (only `.env.example` is tracked, with placeholders). Secrets are read only from environment variables, never logged (redaction), never sent to the frontend or returned by the API. Passwords are bcrypt-hashed; JWT secret is required in production. Do not commit `.env`, and rotate your Atlas password if it was ever shared in plain text (chat, screenshots, screen recordings).

## 24. Limitations
- The ML model is trained on **synthetic** demo data; there is **no live traffic feed** (OSRM is routing-only), so predictions are pattern-based, not real-time.
- Weather is chosen by the user; cost is a rough configurable estimate; OSRM durations are free-flow.
- Public Nominatim/OSRM/tile servers have usage limits and no SLA.
- Personalisation is a simple weighted blend. Driving routes only.
- Road data = documented OpenStreetMap `surface`/`smoothness` tags on a sample of the route (many roads have none); it says nothing about potholes, damage or safety. Scenery = mapped nature-related POIs near the route, not an official or measured rating. Both depend on the public Overpass servers (several are tried in turn), which can be slow or busy — if all fail they show "unavailable", and a road/scenery search can take 10–45 s longer.
- Atlas, Nominatim and OSRM integration depends on your network; use `npm run verify:external` to confirm.

## 25. Future improvements
Real traffic data/feeds and retraining; weather API; learned travel-time regression; multi-stop trips; self-hosted OSRM/Nominatim; real toll data; richer personalisation; end-to-end browser tests against the real services.
