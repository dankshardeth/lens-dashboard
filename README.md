# Lens Protocol activity dashboard

Statikus, ingyenesen futó dashboard a Lens Protocol (Lens Chain) aktivitásáról, angol nyelvű felülettel:

- napi tartalom kliensenként (Hey, Orb, Firefly, Palus + a 3 legaktívabb további app + „Other apps”)
- posztok, kommentek, idézések, repostok naponta
- aktív posztolók (egyedi fiókok) naponta és időszakra
- top 10 legaktívabb fiók összesen és kliensenként (7 / 30 / 90 nap)
- kliens-összehasonlító táblázat részesedéssel és változással

## Hogyan működik

```
Lens API (api.lens.xyz)  →  collect.mjs  →  data/days/*.json  →  site/data.json  →  site/index.html
```

- **Forrás:** a Lens nyilvános GraphQL API-ja. Ingyenes, nem kell kulcs, élő adat.
  (A Lens BigQuery adatkészlete 2026. február 26. óta nem frissül, ezért nem azt használja.)
- **`collect.mjs`:** Node 18+, függőségek nélkül. Minden futáskor újra letölti a tegnapi és a mai napot,
  és pótolja a hiányzó napokat. Az első futás visszatölti a teljes 90 napot (kb. 30 perc).
- **`data/days/`:** naponként egy fájl (app × fiók × típus darabszámok). Az Actions ezt visszaírja a repóba.
- **GitHub Actions + Pages:** 3 óránként frissít és közzéteszi az oldalt. Nyilvános repóban mindkettő ingyenes.

## Beállítás

1. Tedd fel ezt a mappát egy **nyilvános** GitHub repóba (`main` ág).
2. *Settings → Pages → Source:* **GitHub Actions**.
3. *Actions* fül → „Update Lens data and publish” → **Run workflow**.
4. Az első futás után az oldal elérhető a `https://<felhasználó>.github.io/<repó>/` címen.

Opcionális *Settings → Variables*: `LENS_TZ` (pl. `Europe/Budapest`, alap `UTC`), `LENS_DAYS` (alap `90`).

Helyben: `node collect.mjs`, majd `python3 -m http.server -d site 8000`.

## Módszertan

- **Kliens** = a Lens app, amelyhez a tartalom a láncon rögzítve van. A négy fő kliens címe a `collect.mjs` elején van.
- **Típus:** repost, komment (válasz egy posztra), idézés, egyébként poszt. Törölt posztok nincsenek benne.
- **Aktív posztoló** = egyedi fiók, amely aznap vagy az időszakban bármit közölt; időszakra külön számolva.
- Az összesítők és a top 10 teljes napokra számolnak; a mai nap csak a grafikonokon látszik.
- Az API a nyilvánosan látható posztokat adja vissza. Ha a Lens valamit elrejt vagy töröl, az itt sem jelenik meg.
