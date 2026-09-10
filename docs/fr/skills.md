# Compétences

Une compétence est un texte d'instructions de confiance — éventuellement
accompagné de son propre manifeste d'outils — que WebBrain charge dans une
exécution **uniquement quand c'est pertinent**. Gérez-les dans Paramètres →
Compétences, où vous pouvez importer un texte ou une URL de compétence, ou
retirer n'importe quelle compétence intégrée.

## Fonctionnement du chargement

Les exécutions Mid et Full reçoivent un petit catalogue de compétences
éligibles : ID, nom, résumé et intentions sémantiques canoniques optionnelles.
Les instructions complètes ne sont ajoutées au prompt système qu'après
activation de la compétence pour l'exécution en cours, via `load_skill`. **Le
niveau Compact désactive entièrement les compétences** — pas de chargeur, pas de
prompt de compétence, pas d'outils de compétence.

Les compétences importées sont copiées dans le stockage local du navigateur.

## Métadonnées

Un bloc JSON `webbrain-skill` optionnel peut déclarer :

| Champ | Signification |
|---|---|
| `summary` | 200 caractères maximum |
| `modes` | `ask`, `act` et/ou `dev` |
| `intents` | Jusqu'à six intentions canoniques comme `verification_code` ou `public_media_download` |

Les intentions sont des indices de *sens* interlangues destinés au LLM, pas une
correspondance littérale de mots-clés. Les compétences sans métadonnées
déduisent leur résumé du premier paragraphe de prose, n'ont aucune intention
déduite, et utilisent Act/Dev par défaut.

WebBrain reconnaît également les métadonnées YAML obligatoires `name` et
`description` d'un fichier
[Agent Skills `SKILL.md`](https://agentskills.io/specification) importé. Le nom
et la description alimentent le catalogue de routage, et les métadonnées sont
retirées avant le chargement du corps Markdown. Un nom saisi dans Paramètres et
un bloc `webbrain-skill` restent prioritaires.

Cette compatibilité concerne uniquement les instructions. WebBrain importe un
seul document texte ; il ne récupère pas les répertoires `scripts/`,
`references/` ou `assets/`, n'exécute pas le code de la compétence et ne traite
pas le champ Agent Skills `allowed-tools` comme une permission ou un manifeste
d'outils WebBrain. Utilisez `webbrain-tools` pour les outils HTTP WebBrain.
WebBrain ne reconnaît les blocs `webbrain-skill` et `webbrain-tools` que dans
le corps Markdown après des métadonnées valides ; du texte ressemblant à un
bloc dans les métadonnées ne peut ni autoriser le routage ni enregistrer
d'outil.

## Outils de compétence

Une compétence peut exposer des outils HTTP en lecture seule, ou des outils de
tâche de téléchargement de courte durée, via un manifeste JSON `webbrain-tools`.

**Importer une compétence constitue la frontière de confiance de son point de
terminaison HTTPS déclaré.** Les outils de téléchargement d'une compétence
s'exécutent toujours en mode Act et passent par le contrôle de permission
Téléchargements habituel avant d'enregistrer des fichiers. Les résultats
d'outils issus de contenu tiers doivent être marqués
`resultPolicy: "untrusted"` afin d'être encapsulés comme des données et non
comme des instructions.

Les outils HTTP de compétence refusent les redirections (y compris les
redirections opaques du navigateur) : les manifestes doivent utiliser un hôte
HTTPS final qui ne renvoie pas de 3xx.

Les outils de compétence ne font pas partie de la
[matrice des outils](agent-tools.md#matrice-des-outils) statique : avant le
chargement d'une compétence, ou après son retrait, ses outils sont absents.

## Compétences intégrées

Les fichiers markdown packagés vivent sous `skills/` et sont enregistrés dans
`PACKAGED_SKILL_SOURCES` (`agent/skills.js`). Paramètres → Compétences liste
chaque compétence packagée ; seules les valeurs par défaut ci-dessous sont
initialisées comme activées.

### Activées par défaut

Les trois peuvent être retirées dans Paramètres → Compétences. Une valeur par
défaut retirée n'est pas restaurée silencieusement, pas même par la
préactivation.

#### FreeSkillz.xyz

Peut exposer `read_youtube_transcript`, `fetch_nytimes_article`,
`resolve_public_media` et `download_public_media` via son manifeste. Sur les
onglets NYTimes / The Athletic, elle est préactivée pour l'exécution en cours
afin qu'un `pageGate` bloquant structuré puisse router directement vers le repli
d'article sans identifiants.

#### Assistant OTP / code de vérification

Ne se charge que pour les demandes pertinentes et ne déclare aucun outil réseau
externe. En Mid et Full, il ajoute un lecteur interne limité pour un onglet de
webmail compatible, déjà ouvert et connecté. `inspect` ne modifie pas la boîte
et reste disponible dans Ask. Comme l'ouverture peut marquer le message comme
lu, `open_message` exige Act/Dev ainsi que l'autorisation de clic pour l'hôte de
la boîte ; une copie temporaire inactive est alors créée, toutes les
continuations bornées du message sont lues (sinon l'opération échoue de manière
fermée), puis la copie est fermée. Le modèle reçoit des références de message opaques, jamais le
catalogue des onglets, l'URL de la boîte ni les références d'accessibilité.
Compact ne reçoit aucun outil de compétence ou inter-onglets. Sur l'onglet de
l'exécution active, il privilégie toujours le texte sélectionné ou un sous-arbre
borné, exclut l'accès aux SMS et aux applications natives, et respecte la
gestion stricte des secrets.

Lorsqu'il est utilisé, le contenu de page délimité et le code sont inclus dans la
requête normale envoyée au fournisseur LLM que vous avez configuré. Si
**l'enregistrement des traces** est activé, les résultats d'outils bruts et les
réponses du modèle sont également stockés localement jusqu'à la suppression de
ces traces.

#### Humanizer

Réécrit la prose que WebBrain rédige pour vous, par exemple une réponse à un
e-mail ou une publication, afin qu'elle se lise comme un texte humain. Elle ne
déclare aucun outil réseau et n'ajoute aucun outil.

Sur les onglets de webmail (Gmail, Outlook, Yahoo, Proton, Fastmail, Zoho,
Yandex), elle est préactivée pour l'exécution en cours, si bien qu'une réponse
est humanisée sans dépenser un appel `load_skill`. La préactivation repose sur
la correspondance d'adaptateur de site : elle n'a donc aucun effet si les
**adaptateurs de site** sont désactivés dans les Paramètres, et la compétence se
charge alors via le catalogue comme ailleurs. Ailleurs, elle se charge via le
catalogue normal lorsque la demande porte sur la rédaction ou la réécriture
d'un texte. Elle ne renvoie que le texte final et n'explique pas ses
modifications, sauf si vous le demandez.

Sélectionnez du texte n'importe où et une entrée **Humanize** apparaît, dans la
fenêtre flottante comme dans le menu contextuel. Cette entrée explicite
préactive la compétence sur tous les sites ; les tours suivants de la même
conversation la conservent. Les actions prédéfinies — Summarize, Explain, Quiz
me, Proofread, Translate — et les questions libres saisies dans la zone de
sélection ne le font pas, car elles n'établissent pas une demande de rédaction
structurée. Ce routage existe parce qu'une exécution sur texte sélectionné
n'embarque aucun outil : le catalogue lui est inaccessible, et une compétence
absente au démarrage ne peut plus être chargée ensuite.

Elle ne réécrit que la prose destinée à un lecteur humain. Le contenu cité, les
adresses, les codes, les prix, les valeurs de champs de formulaire et la
formulation que vous fournissez mot pour mot restent intacts.

### Compétences packagées à activer

Ces compétences sont livrées avec l'extension et apparaissent dans Paramètres →
Compétences comme disponibles. Elles ne sont pas activées par défaut.

| Compétence | Modes | Outils réseau |
|---|---|---|
| E-mail jetable (Mail.tm) | Act, Dev | API HTTPS Mail.tm |
| Partage de fichier temporaire (Litterbox) | Act, Dev | Outils d'upload du navigateur ; lien public de courte durée |
| Météo Open-Meteo | Ask, Act, Dev | Géocodage + prévisions HTTPS |
| Open Library | Ask, Act, Dev | Recherche Open Library HTTPS |
| Wikipédia | Ask, Act, Dev | Recherche REST + résumé Action API HTTPS |
| Restauration des caractères turcs | Ask, Act, Dev | Instructions uniquement ; utilise les outils ordinaires de saisie textuelle |

N'activez une compétence que si vous voulez ses outils et instructions
disponibles pour `load_skill` sur les exécutions éligibles.

## Voir aussi

- [Outils de l'agent](agent-tools.md) — niveaux, modes et matrice complète
- [Confidentialité et flux de données](privacy-and-data-flow.md)
- [Architecture](architecture.md) — compétences et exposition dynamique des
  outils dans le flux d'un tour
