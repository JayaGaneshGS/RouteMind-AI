# Viva Questions & Answers — RouteMind AI

**0. How do "Better Road Conditions" and "Better Scenery" work, and what do they NOT claim?**
Both use OpenStreetMap data read through the Overpass API and are computed only when asked for. Road conditions: points are sampled along each OSRM route, the OSM way matching OSRM's road name is looked up and its `surface`/`smoothness` tags are turned into a documented 0–100 score; roads without those tags earn no credit and are reported as unknown, and a motorway/primary class is shown but never scored as good pavement. Scenery: named beaches, viewpoints, parks, reserves, lakes, forests and attractions near the route line are counted once each (dedupe, per-category cap, saturating curve, relevance and distance weights). Neither claims potholes, safety or an official scenic rating; if Overpass fails the UI says "unavailable" and the recommendation uses only time, traffic and cost. See README section 16a.

**1. What does the project do?**
It finds routes between two places on OpenStreetMap data, predicts the traffic level for each route and departure time with a trained ML model, scores the alternatives against the user's preference (fastest / cheapest / low traffic / balanced), and recommends one with a plain-language explanation.

**2. Is the traffic prediction real-time?**
No. There is no live traffic feed. The model predicts a *typical* traffic level from hour, day, weekend, distance, weather, road type and a historical-congestion feature. It is trained on a synthetic academic-demonstration dataset, and the UI says so.

**3. Which ML algorithm and why?**
RandomForestClassifier: handles mixed numeric/categorical features after one-hot encoding, captures non-linear interactions (peak hour × road type × rain), needs little tuning, gives class probabilities and feature importances (explainable), and is robust on small tabular data.

**4. How was the model evaluated?**
Stratified 80/20 hold-out plus 5-fold cross-validation. Metrics: accuracy ≈ 0.80, weighted precision/recall/F1 ≈ 0.80, CV accuracy ≈ 0.825 on the demo data. Confusion matrix and feature importances are saved in `metrics.json`. These numbers apply to the synthetic data only.

**5. The dataset is synthetic — isn't that a problem?**
It is a stated limitation. The dataset encodes realistic patterns so the whole pipeline (preprocess → train → evaluate → serve) is genuine. In production you would retrain on real data (GPS probe data or a traffic feed); only `traffic_data.csv` would change.

**6. How is travel time predicted?**
Base free-flow time from OSRM × a traffic multiplier (LOW 1.05, MEDIUM 1.20, HIGH 1.45), configurable via `TRAFFIC_MULTIPLIERS`. It's an analytical model, kept simple for stability.

**7. How does route scoring work?**
Three sub-scores scaled 0–100 — time (fastest/this), cost (cheapest/this), traffic (1 − expected congestion) — combined with preference-dependent weights (e.g. Low Traffic: 0.55 traffic, 0.30 time, 0.15 cost). The highest score is the recommended route.

**8. How is personalisation done?**
The weights are blended 85/15 with the average weights of the user's last ≤10 saved-trip preferences (plus a non-default saved mode), once at least two such choices exist. It is deliberately simple and explainable.

**9. Where is AI used and what happens without an API key?**
(a) Interpreting free-text preferences into priorities, (b) generating the explanation. With `AI_API_KEY` an OpenAI-compatible LLM is used; its JSON output is validated against fixed enums. Without a key (or on failure) a rule-based parser and template explanation are used, so the app is fully functional.

**10. How do you protect against prompt injection?**
User text is length-limited (300 chars), sent only as data, and the LLM output is strictly validated against enums before use. The explanation is plain text only, rendered as text (not HTML) and length-limited.

**11. How is authentication implemented?**
Passwords are hashed with bcrypt (cost 10), never stored or returned in plain text. Login returns a JWT (HS256, 7 days) sent as a Bearer token. Login errors don't reveal whether an email exists. Auth endpoints are rate limited.

**12. Why Node → Python instead of calling ML from the browser?**
The ML service is internal; Node validates input, applies auth and rate limits, handles failures (fallback), and keeps secrets and service URLs off the client.

**13. What happens if a service is down?**
No fake data is ever substituted. OSRM down → 503 "Routing service unavailable"; Nominatim down → 503 "Location service unavailable"; MongoDB Atlas down → 503 "Database unavailable" (no in-memory fallback); ML down → a clearly labelled rule-of-thumb with the UI warning "ML service unavailable — fallback prediction used" (or an error if `ML_FALLBACK=off`); LLM down/no key → rule-based AI, labelled.

**14. How do you respect public API limits?**
Results cached (geocoding 24 h, routes 10 min), a ≥1.1 s throttle between calls, identifying User-Agent (`GEOCODE_USER_AGENT`), no autocomplete — lookups only when the user submits — and configurable base URLs so you can self-host. The health endpoint never calls Nominatim/OSRM.

**15. How are route alternatives obtained?**
Directly from OSRM (`alternatives=true`). Whatever OSRM returns is shown — one route if that is all it returns. No alternatives are generated or invented.

**16. Why MongoDB Atlas?** Flexible nested documents (trip with route data), managed cloud database (no local DB to install), native fit with Node/Mongoose. The connection string lives only in `.env` (`MONGO_URI`) and is never logged.

**17. Explain the Docker setup.**
Three containers: `ml-service` (trains the model at image build), `backend` (waits for a healthy ML service), `frontend` (nginx serving the SPA and proxying `/api`). MongoDB Atlas is external, configured via `MONGO_URI` in `.env`. `docker compose up --build`.

**18. Explain the CI pipeline.**
Four GitHub Actions jobs: frontend (tests + build), backend (check + tests against a real MongoDB service container), ML (generate data, train, pytest), Docker (`docker compose build`).

**19. How is the system tested?**
Python: model load, endpoint shape/validation, learned-pattern sanity check, travel time. Backend unit + API tests (external services mocked locally; they check the exact requests sent and the no-fake-data behaviour). `npm run verify:external` is the manual test against the real Atlas, Nominatim, OSRM and ML service. Frontend: helper tests and build.

**20. Known limitations?**
Synthetic data, no live traffic (OSRM is routing only), user-chosen weather, rough cost model, public servers have no SLA, simple personalisation, driving only.

**21. How would you improve the ML?**
Real traffic data, time-series features, weather API, gradient boosting, calibration, regression for travel time, periodic retraining and monitoring.

**22. Why is `route_type` derived from speed?**
OSRM doesn't label road classes in our request; average free-flow speed is a cheap proxy (≥65 km/h ≈ highway, ≥45 mixed, else city) that matches the training feature.

**23. Why not autocomplete on the location box?**
The Nominatim usage policy forbids autocomplete-style traffic; explicit search plus caching keeps usage polite.

**24. Why is scoring in Node and not Python?**
Scoring needs the user's preferences/history from MongoDB, which Node already owns; keeping it in Node avoids an extra network hop. The Python service owns pure ML (traffic, travel time).
