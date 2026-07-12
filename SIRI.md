# Siri / HomePod (Apple Shortcuts)

HomePod has no GPS. Use fixed `HOME_LAT` / `HOME_LON` in `.env`, then build a Shortcut:

1. **Get Contents of URL** → `https://YOUR_HOST/siri/nearby`
2. **Speak Text**
3. **Ask for Input** → “Which bus?” (Number)
4. **Get Contents of URL** → `https://YOUR_HOST/siri/bus?bus=[Provided Input]`
5. **Speak Text**
6. Add to Siri phrase: **nearby buses**

Browser speak uses the Web Speech API on the interactive homepage (`/`).
