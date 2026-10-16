# 💬 Chattyboys

Kolme Claude-agenttia, joilla on eri persoonallisuus, keskustelee reaaliajassa siitä, miten
tienata rahaa verkossa. Sinä seuraat keskustelua kauniissa selainkäyttöliittymässä, vastaat
heidän kysymyksiinsä, hyväksyt tai hylkäät lupapyynnöt ja myönnät heille uusia **voimia**.

| | Agentti | Rooli |
|---|---|---|
| 🦄 | **Vilma** | Visionääri – isot ideat, brändit, trendit |
| 🦉 | **Tauno** | Skeptikko & analyytikko – luvut, riskit, ALV, laillisuus |
| 🦊 | **Rax** | Hustler & rakentaja – MVP tänään, kirjoittaa tiedostoja, ehdottaa työkaluja |

## Käynnistys

Tarvitset Node.js 20+ (ei npm-riippuvuuksia).

```bash
node server.js
# avaa http://localhost:3000
```

### Omat Claude-tunnuksesi

* **Oletus:** käytetään koneellesi asennettua **Claude Code CLI:tä** (`claude`) ja sen kirjautumista
  (Claude Pro/Max -tilaus tai API). Kirjaudu kerran: `claude` → `/login`.
* **Vaihtoehto:** aseta `ANTHROPIC_API_KEY=sk-ant-...`, jolloin kutsut menevät suoraan Anthropic API:in.

## Tokenibudjetti (ettei päivän kiintiö lopu)

Oletusrajat, joita voi muuttaa käyttöliittymän ⚙️-välilehdeltä tai ympäristömuuttujilla:

| Asetus | Oletus | Ympäristömuuttuja |
|---|---|---|
| Tokenit / päivä | 150 000 (~25 vuoroa) | `DAILY_TOKEN_LIMIT` |
| Puheenvuorot / päivä | 60 | `MAX_TURNS_PER_DAY` |
| Tauko vuorojen välissä | 20 s | `TURN_DELAY_SEC` |
| Malli | `claude-sonnet-5-5` | `MODEL` (esim. `claude-haiku-5-5` on halvempi) |

Agentit pysähtyvät automaattisesti **ennen** rajaa (arvio seuraavan vuoron koosta) ja jatkavat
seuraavana päivänä. He pysähtyvät myös odottamaan, jos sinulla on 3 vastaamatonta pyyntöä, sekä
kolmen peräkkäisen virheen jälkeen. Mittarit näkyvät yläpalkissa.

## Miten se toimii

* **Keskustelu** – vuorot kiertävät, ja agentti voi nimetä seuraavan puhujan. Voit kirjoittaa
  väliin – mainitse nimi, niin hän vastaa seuraavaksi. Voit myös vaihtaa aihetta.
* **📥 Pyynnöt** – agentit voivat
  * ❓ kysyä sinulta (aika, budjetti, taidot, päätökset),
  * 🔐 pyytää lupaa oikean maailman toimiin (rahan käyttö, tilit, julkaisu – riskitaso ja hinta näkyvät),
  * ⚡ ehdottaa uusia voimia,
  * 🧑‍🔧 antaa sinulle tehtäviä (manual-voimat) – sinä teet ne ja raportoit tuloksen.
* **💡 Ideat** – ideataulu tiloineen ja arvioituine €/kk-potentiaaleineen. Peukuta 👍/👎.
* **⚡ Voimat** – kyvyt, joita agentit käyttävät:
  * valmiina: `workspace_write`, `workspace_read`, `workspace_list` (tiedostot `workspace/`-kansioon)
  * lukittuina (agentit pyytävät avaamista): `web_fetch`, `web_search`
  * **manual** – agentti määrittelee tehtävän, sinä suoritat sen oikeassa maailmassa
  * **script** – agentti kirjoittaa Node.js-skriptin. Näet koodin ennen hyväksyntää, ja jokainen ajo
    hyväksytään erikseen (ellei rastita "aja kysymättä"). Skriptit ajetaan Noden permission-mallilla:
    tiedostoihin pääsy vain `workspace/`-kansioon, ei aliprosesseja, 30 s aikaraja. Verkko (fetch) on sallittu.
* **📁 Työtila** – agenttien kirjoittamat luonnokset, suunnitelmat ja sivut.

## Turvallisuus

* Palvelin kuuntelee oletuksena vain osoitteessa `127.0.0.1`, koska se käyttää tunnuksiasi.
* Agenteilla ei ole Claude Coden työkaluja (`--tools ""`), joten he voivat tehdä *vain* yllä listattuja asioita.
* Mitään rahaa käyttävää, tilejä luovaa tai julkaisevaa ei tapahdu ilman sinun hyväksyntääsi –
  käytännössä sinä teet ne itse manual-voimien kautta.
* Ohjeistus kieltää huijaukset, roskapostin, valeprofiilit ja muun laittoman toiminnan.

Tila tallentuu tiedostoon `data/state.json`, joten keskustelu jatkuu uudelleenkäynnistyksen jälkeen.
