# Upkeep

Runs the Upkeep server, which keeps the job schedule, the runs and their logs. The jobs themselves run on your other machines as workers, so nothing heavy runs on Home Assistant.

The full documentation is at [upkeep.timmo.dev](https://upkeep.timmo.dev), including [running it](https://upkeep.timmo.dev/running) and every setting.

## Setting up

1. Set **server_admin_token** to a long random value, at least 32 characters, such as from `openssl rand -base64 32`, and start the app.
2. From a machine with `upkeep` installed, add an admin of your own and a worker for each machine that runs jobs:

   ```sh
   export UPKEEP_SERVER=http://homeassistant.local:7272
   export UPKEEP_ADMIN_TOKEN=<the same value>
   upkeep admins add me
   upkeep workers add desktop
   ```

3. Give each worker the server's URL and its printed token in `UPKEEP_SERVER` and `UPKEEP_WORKER_TOKEN`.
4. Add the repositories Upkeep should work on with `upkeep repos add owner/name`. Until you do, the jobs that work on repositories do nothing.

With 1Password, [`setup-1password.sh`](https://upkeep.timmo.dev/running#first-setup-with-1password) does the first two steps and keeps every token in it.

The server speaks plain HTTP on port 7272, so tokens are only as private as your network. To reach it from outside, put it behind a reverse proxy or a Cloudflare tunnel for HTTPS.

## Dashboard

Open **Upkeep** in the sidebar for the dashboard: an inbox of what changed in your repositories and what needs you, then the jobs with their last run, the latest runs, and each run's log as it goes. Home Assistant has already signed you in, so it needs no token there. The dashboard takes the whole screen, without Home Assistant's sidebar and header: the menu button at the start of its bar shows the sidebar over it, and on a phone it's the last item in the dashboard's menu. It's also at `http://homeassistant.local:7272/`, where it asks for an admin token.

## Options

These match the server's settings of the same name, without the `UPKEEP_` prefix.

- **server_admin_token**: an admin token the server always accepts. It isn't stored or listed. Leave it empty once you've added an admin of your own.
- **heals_per_day**: how many heals one job can have for each repository, or for itself, in any 24 hours. A repository past it has its heal held, and queued once its oldest heal is a day old; a job failing in itself is parked.
- **keep_days**: how many days finished runs and their logs are kept.
- **keep_runs**: how many of each job's latest finished runs are kept however old.
- **triage_host_token** and **triage_admin_token**: tokens for a triage server to remember failures in. Heals work without it. Add them with `triage hosts add upkeep` and `triage admins add upkeep`, rather than using triage's server admin token. With the triage app from the same repository installed and running, Upkeep finds it on the Supervisor's network. Set **triage_url** for a triage server anywhere else.
- **events_account_id**, **events_queue_id** and **events_token**: the Cloudflare Queue GitHub's events arrive in, and an API token with Queues edit to pull them. Without them, jobs run on their schedules alone. Setting up the GitHub App, Worker and queue is in [GitHub events](https://upkeep.timmo.dev/events).
- **github_app_id** and **github_app_key**: the GitHub App the jobs' own GitHub calls run as, and its private key, pasted as it is or in base64. Workers are handed an installation token for each run of a job that works across repositories, such as a bump or a sync, so those calls count against the App's rate limit; heals and agents keep the worker's login. Set **github_app_account** only when the App is installed on more than one account. Without them, every job uses the worker's login. See [GitHub events](https://upkeep.timmo.dev/events#jobs-as-the-app).

The database is kept in the app's data, and the app stops briefly during backups so it's copied consistently.
