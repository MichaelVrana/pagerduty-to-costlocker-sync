# PagerDuty to CostLocker synchronization script

Synchronizes PagerDuty oncalls into CostLocker.

### How to use

First you need to generate a [personal API Key in PagerDuty](https://support.pagerduty.com/main/docs/api-access-keys#generate-a-user-token-rest-api-key) and [retrieve your CostLocker API Key](https://app.costlocker.com/settings/api).

Then pass those two keys into the `npm start` command:
```sh
npm start -- --pdApiKey "$YOUR_PERSONAL_PAGERDUTY_API_KEY" --clApiKey "$COSTLOCKER_API_KEY"
```

Beware that the script first deletes all previous oncall worklogs in the given period to make sure the data between PD and CL are well synchronized.

See more CLI options using the `--help` flag.