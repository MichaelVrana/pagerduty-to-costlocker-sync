import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { api as pdApi } from '@pagerduty/pdjs'
import {
  startOfMonth,
  endOfDay,
  addSeconds,
  isWithinInterval,
} from 'date-fns'
import { partition } from 'ramda'
import { v4 as uuid } from 'uuid'
import { formatInTimeZone } from 'date-fns-tz'

const oncallsChunkSize = 100

const fetchOncallChunk = async (offset) =>
  await pd
    .get(`/oncalls`, {
      queryParameters: {
        'user_ids[]': [currentPdUser.id],
        'schedule_ids[]': [args.pdScheduleId],
        time_zone: 'Etc/UTC',
        since: args.since,
        until: args.until,
        limit: oncallsChunkSize,
        offset,
      },
    })
    .then((res) => res.data.oncalls)

const fetchOncalls = async () => {
  const results = []

  while (true) {
    const chunk = await fetchOncallChunk(results.length)

    results.push(...chunk)

    if (chunk.length < oncallsChunkSize) break
  }

  return results
}

const costLockerUrl = 'https://rest.costlocker.com/api'

const costlockerFetch = async (body) => {
  const headers = {
    Authorization: `Static ${args.clApiKey}`,
    'Content-Type': 'application/json',
  }

  return await fetch(costLockerUrl, {
    body: JSON.stringify(body),
    method: 'POST',
    headers,
  }).then((res) => res.json())
}

const fetchCostlockerWorklogs = async () => {
  const costlockerDtoIn = {
    '7_Report_Timesheet': {
      datef: new Date(args.since).toLocaleDateString('sv-SE'), // gives YYYY-MM-DD
      datet: new Date(args.until).toLocaleDateString('sv-SE'), // gives YYYY-MM-DD - costlocker interval is inclusive
      personDisabled: null,
      nonproject: true,
      person: {
        or: [costlockerUser.key],
        and: [],
        not_or: [],
      },
    },
    Report_Timesheet_Items: {
      pageByEntry: true,
      limit: 5000,
      offset: 0,
    },
  }

  const response = await costlockerFetch(costlockerDtoIn)

  return response.Report_Timesheet_Items
}

const fetchCostLockerUser = async () => {
  const user = await costlockerFetch({
    '7_Lst_Person': {},
    '7_Identities': {},
  })

  return user['7_Lst_Person'].filter(
    (item) => item.key === user['7_Identities'][0].person_id.toString()
  )[0]
}

const deleteClWorklog = async (woklogId) => {
  await costlockerFetch({
    '5_Resource_Tracking_TrackingDelete': {
      key: woklogId,
    },
  })
}

const getClWorklogEnd = (worklog) =>
  addSeconds(new Date(worklog.dt), worklog.in)

const createCostlockerOncallWorklog = async ({ start, end }) => {
  await costlockerFetch({
    '5_Resource_Tracking_TrackingSave': {
      Tracking: {
        uuid: uuid(),
        name: '',
        project_id: args.clProjectId,
        activity_id: args.clActivityId,
        task_id: args.clTaskId,
        dt: formatInTimeZone(start, 'Europe/Prague', 'yyyy-MM-dd HH:mm:ss'),
        in: Math.round((end.getTime() - start.getTime()) / 1000),
      },
    },
  })
}

const now = new Date()

const args = await yargs(hideBin(process.argv))
  .options({
    pdApiKey: {
      string: true,
      demandOption: true,
      description: 'PagerDuty API Key.',
    },
    pdScheduleId: {
      string: true,
      default: 'PVSO6AU',
      description:
        'The ID of the PagerDuty schedule. You can find this using the PD REST API v2 /schedules endpoint.',
    },
    clProjectId: {
      string: true,
      demandOption: true,
      description: 'CostLocker on-call project ID.',
    },
    clActivityId: {
      string: true,
      demandOption: true,
      description: 'CostLocker on-call task ID.',
      default: '17514',
    },
    clTaskId: {
      string: true,
      demandOption: true,
      description: 'CostLocker on-call task ID.',
    },
    clApiKey: {
      string: true,
      demandOption: true,
      description: 'CostLocker API Key.',
    },
    since: {
      string: true,
      default: startOfMonth(now).toISOString(),
      description:
        'ISO timestamp marking the beginning from which worklogs will be synchronized. Default is start of current month.',
    },
    until: {
      string: true,
      default: endOfDay(now).toISOString(),
      description:
        'ISO timestamp marking the beginning from which worklogs will be synchronized. Default is end of today.',
    },
  })
  .parse()

const pd = pdApi({ token: args.pdApiKey })

const currentPdUser = await pd.get('/users/me').then((res) => res.data.user)

const oncalls = await fetchOncalls()

const uniqueOncalls = [
  ...new Map(
    oncalls.map((oncall) => [`${oncall.start}-${oncall.end}`, oncall])
  ).values(),
]

const costlockerUser = await fetchCostLockerUser()

const costlockerWorklogs = await fetchCostlockerWorklogs()

const [oncallWorklogs, nonOncallWorklogs] = partition(
  ({ project_id, task_id, activity_id }) =>
    project_id === args.clProjectId &&
    task_id === args.clTaskId &&
    activity_id === args.clActivityId,
  costlockerWorklogs
)

console.log('Deleting old worklogs')

for (const oncallWorklog of oncallWorklogs) {
  console.log(
    `Deleting worklog ${oncallWorklog.name} from ${
      oncallWorklog.dt
    } - ${getClWorklogEnd(oncallWorklog).toISOString()}`
  )

  await deleteClWorklog(oncallWorklog.uuid)
}

console.log('Old worklogs deleted')

console.log('Creating oncall worklogs')

const worklogIntervals = nonOncallWorklogs.map((worklog) => ({
  start: new Date(worklog.dt),
  end: getClWorklogEnd(worklog),
}))

for (const oncall of uniqueOncalls) {
  const oncallInterval = {
    start: new Date(oncall.start),
    end: new Date(oncall.end),
  }

  console.log(
    `Creating worklogs for oncall ${oncallInterval.start.toISOString()} - ${oncallInterval.end.toISOString()}`
  )

  const worklogsDuringOncallPeriod = worklogIntervals
    .filter(({ start }) => isWithinInterval(start, oncallInterval))
    .toSorted((a, b) => a.start.getTime() - b.start.getTime()) // assumes no overlap between intervals

  const emptySpotsBetweenWorklogs = worklogsDuringOncallPeriod.reduce(
    (acc, curr, idx, arr) => {
      const next = arr[idx + 1]

      if (!next) return acc

      return acc.concat({ start: curr.end, end: next.start })
    },
    []
  )

  const newOncallWorklogIntervals = [
    {
      start: oncallInterval.start,
      end: worklogsDuringOncallPeriod[0]?.start ?? oncallInterval.end,
    },
    ...emptySpotsBetweenWorklogs,
    {
      start: worklogsDuringOncallPeriod.at(-1)?.end ?? oncallInterval.end, // if there are no worklogs this should make this element to be filtered out later
      end: oncallInterval.end,
    },
  ]

  const validNewWorklogIntervals = newOncallWorklogIntervals.filter(
    ({ start, end }) => {
      return start.getTime() < end.getTime()
    }
  )

  for (const newWorklogInterval of validNewWorklogIntervals) {
    console.log(
      `Creating on call worklog ${newWorklogInterval.start.toISOString()} - ${newWorklogInterval.end.toISOString()}`
    )

    await createCostlockerOncallWorklog(newWorklogInterval)
  }
}

console.log('Worklog creation finished')
