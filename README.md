# Souffle

Tableau de bord interactif (FastAPI) pour prévoir le PM2.5 à J+1 et J+2, simuler la dose inhalée par épreuve d'athlétisme (Monte-Carlo) et en déduire un niveau d'exposition et une action recommandée.

C'est la version web du script R `sarimax_pm25_forecast_classification.R` (fourni dans `original/`).

## Démarrage rapide

Prérequis : Python 3.10 ou plus récent.

**Windows** : double-cliquez sur `lancer.bat`.
**Mac / Linux** : `./lancer.sh`

Le premier lancement crée un environnement virtuel et installe les dépendances (1 à 2 minutes). Le navigateur s'ouvre sur http://127.0.0.1:8000.

Sans les scripts :

```bash
python -m venv .venv
source .venv/bin/activate        # Windows : .venv\Scripts\activate
pip install -r requirements.txt
python run.py                    # options : --port 8080 --host 0.0.0.0 --no-browser
```

Avec Docker : `docker build -t souffle . && docker run -p 8000:8000 souffle`

## Parcours dans l'application

| Étape | Ce qui se passe |
|---|---|
| 1. Données | Import du fichier Excel (ou CSV). Colonnes attendues : `Date`, `TC`, `HR`, `PM2.5`. La feuille `Donnees_Completes` est choisie si elle existe, sinon la première ; un sélecteur permet d'en changer. Les jours absents et valeurs vides sont comblés par interpolation linéaire. |
| 2. Modèle | Ajustement de trois modèles : TC et HR (ARIMA saisonnier, période 7) puis PM2.5 ~ TC + HR (régression à erreurs ARIMA). Ordre choisi au meilleur AICc. Coefficients, AICc/BIC, RMSE, R², test de Ljung-Box, ajusté vs observé, autocorrélation des résidus. |
| 3. Prévisions | TC et HR sont prévus, puis injectés comme régresseurs pour prévoir le PM2.5 à J+1 et J+2 : moyenne, IC 95 %, P25, P50, P95. |
| 4. Simulation | Monte-Carlo (10 000 tirages par défaut, graine 42, modifiables) : `Dose = Concentration × Ventilation × Durée × 0,001`, chaque facteur suivant une loi triangulaire. Histogrammes par épreuve. |
| 5. Classification | Classe de concentration (sur le P50), classe de dose (sur le P50 de la dose), niveau provisoire 1 à 3 et action. Téléchargement des résultats. |

Le bouton « Tout exécuter d'un coup » enchaîne les étapes 2 à 5.

## Exports

Depuis l'étape 5 : `souffle_resultats.zip` (tout), `souffle_resultats.xlsx` (prévisions, classification, coefficients, paramètres), `exposure_classification.csv` et `pm25_forecast.csv`. Ces deux CSV ont les mêmes colonnes que ceux du script R.

## Structure

```
souffle/
├── run.py                  point d'entrée
├── lancer.bat / lancer.sh  installation + lancement en un clic
├── requirements.txt
├── Dockerfile
├── app/
│   ├── main.py             API FastAPI (routes, sessions, exports)
│   ├── pipeline.py         chargement, auto-ARIMA, prévisions, Monte-Carlo, classification
│   ├── config.py           paramètres des épreuves, seuils, règle niveau/action
│   └── static/             interface (HTML, CSS, JS, Plotly et polices embarqués : fonctionne hors ligne)
├── data/
│   ├── exemple_dataset.xlsx   données SYNTHÉTIQUES pour tester
│   └── generer_exemple.py
└── original/
    └── sarimax_pm25_forecast_classification.R
```

Pour modifier les paramètres des épreuves (ventilation, durée), les seuils ou la table niveau/action, éditez `app/config.py`.

## API

Documentation interactive : http://127.0.0.1:8000/docs. Chaque requête porte l'en-tête `X-Session-Id` (généré par l'interface) qui isole l'état de chaque utilisateur.

| Méthode | Route | Rôle |
|---|---|---|
| POST | `/api/upload` | Import d'un fichier (multipart, champ `file`, option `sheet`) |
| POST | `/api/upload-sample` | Charge les données d'exemple |
| POST | `/api/data/sheet` | Change de feuille Excel |
| POST | `/api/model` | Ajuste les trois modèles |
| POST | `/api/forecast` | Prévisions J+1 et J+2 |
| POST | `/api/simulate` | Monte-Carlo (`n_sim`, `seed`) |
| GET | `/api/classification` | Tableau de classification |
| GET | `/api/download/{forecast\|classification\|xlsx\|all}?sid=...` | Exports |

## Écarts par rapport au script R

À connaître avant de comparer les chiffres :

1. **Recherche du modèle.** R utilise `auto.arima(stepwise = FALSE)`, une recherche exhaustive. Python n'a pas d'équivalent exact intégré à `statsmodels` ; l'application implémente la recherche pas-à-pas de Hyndman-Khandakar (critère AICc, test KPSS pour `d`, force saisonnière pour `D`, rejet des modèles à racines proches du cercle unité, comme `auto.arima`). Sur certaines séries, l'ordre retenu peut différer de celui de R, et les prévisions avec lui.
2. **Dérive.** Pour un modèle différencié (`d ≥ 1`), `auto.arima` peut ajouter une dérive ; cette version n'en ajoute pas. Une constante est incluse quand `d = 0`.
3. **Nombres aléatoires.** Les générateurs de R et de NumPy diffèrent : à graine égale, les quantiles de dose varient légèrement (écart-type du P50 mesuré entre graines : environ 0,04 mg pour le 3000 m et 0,09 mg pour le 5000 m marche, à 10 000 tirages). Les classes ne changent que si une médiane est très proche d'un seuil.
4. **Non vérifié contre R.** R n'était pas disponible pour tester cette version : l'équivalence repose sur la relecture du code, pas sur une comparaison numérique. Comparez avec vos propres résultats R sur votre fichier réel.

Les libellés du CSV restent ceux du script R (`Faible`, `Moderee`, `Elevee`, sans accents) ; l'interface les affiche avec accents.

## Limites de déploiement

L'état des sessions est gardé en mémoire (25 sessions maximum) : lancez un seul processus (pas de `--workers`), et prévoyez une base ou un cache partagé si vous déployez pour de nombreux utilisateurs. Le serveur n'a pas d'authentification.
