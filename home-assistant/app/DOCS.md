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

The server speaks plain HTTP on port 7272, so tokens are only as private as your network. To reach it from outside, put it behind a reverse proxy or a Cloudflare tunnel for HTTPS.

## Dashboard

Open **Upkeep** in the sidebar for the dashboard: the jobs with their last run, the latest runs, and each run's log as it goes. Home Assistant has already signed you in, so it needs no token there. It's also at `http://homeassistant.local:7272/`, where it asks for an admin token.

## Options

These match the server's settings of the same name, without the `UPKEEP_` prefix.

- **server_admin_token**: an admin token the server always accepts. It isn't stored or listed. Leave it empty once you've added an admin of your own.
- **heals_per_day**: how many heals one job can have a day before it's parked.
- **keep_days**: how many days finished runs and their logs are kept.
- **keep_runs**: how many of each job's latest finished runs are kept however old.
- **triage_url**, **triage_host_token** and **triage_admin_token**: a triage server to remember failures in. Heals work without it.

The database is kept in the app's data, and the app stops briefly during backups so it's copied consistently.
