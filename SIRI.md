# HomePod + Apple Shortcuts

Live server: **https://bus-20ks.onrender.com**

Lat/lon are set on **Render** as env vars — do **not** put them in Shortcut URLs.

## 1. Render environment

In Render → your service → **Environment**, set:

```env
HOME_LAT=45.2719807
HOME_LON=-75.7386003
OCTRANSPO_SUBSCRIPTION_KEY=your_key
```

(150 Marketplace Ave, Barrhaven)

Save / redeploy. Then test in Safari:

`https://bus-20ks.onrender.com/siri/nearby`

You should hear/see nearby buses — **not** “missing lat/lon”.

---

## 2. Shortcut URLs (no lat/lon)

**Nearby**

```text
https://bus-20ks.onrender.com/siri/nearby
```

**Bus**

```text
https://bus-20ks.onrender.com/siri/bus?bus=[Provided Input]
```

---

## 3. Two Shortcuts (best for HomePod)

### Nearby Buses
1. URL → `https://bus-20ks.onrender.com/siri/nearby`
2. Get Contents of URL
3. Speak Text
4. Add to Siri: **nearby buses**

### Bus Arrival
1. Ask for Input → `Which bus?` · Number
2. URL → `https://bus-20ks.onrender.com/siri/bus?bus=` + Provided Input
3. Get Contents of URL
4. Speak Text
5. Add to Siri: **bus arrival**

Usage:

> Hey Siri, nearby buses  
> Hey Siri, bus arrival → **75**

Enable **Personal Requests** on the HomePod.

---

## Notes

- First request after idle can be slow (Render sleep)
- Optional: `?radius=800` if you want a wider search
- Change home later by updating `HOME_LAT` / `HOME_LON` on Render only
