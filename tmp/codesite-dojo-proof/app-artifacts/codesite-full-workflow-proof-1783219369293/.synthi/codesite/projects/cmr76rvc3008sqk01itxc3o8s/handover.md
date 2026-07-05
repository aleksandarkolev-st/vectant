# CodeSite Handover: Full workflow proof

Workspace: codesite-full-workflow-proof-1783219369293
Project: cmr76rvc3008sqk01itxc3o8s
Status: active

## Black Box

- Events recorded: 79
- Clearances issued: 3
- Transactions tracked: 4
- Incidents replayable: 4
- Proof bundles: 1

## Proof-Carrying Commits

- cmr76z76b00gjqk01x6cwpr50: transaction cmr76sqte00blqk01jga6jnj3, CodeSite-Black-Box sha256:0440d3ec904cc611fa4f78850026ddb97d51be44de844762ad252f73b930b531, replay sha256:0440d3ec904cc611fa4f78850026ddb97d51be44de844762ad252f73b930b531

## Causal Replay Packets

- cmr76snbq00bhqk01ohox8ez4: black_box sha256:e97996daf2fd26e4aa96a51e4737346d37f8bcaf0357fff959c1409c26f9e88a (100% complete)
  Transaction: cmr76sgjw00b5qk01xadbal59; proof: n/a
  Export refs: projects/cmr76rvc3008sqk01itxc3o8s/incidents/incident-replay-cmr76snbq00bhqk01ohox8ez4.jsonl, projects/cmr76rvc3008sqk01itxc3o8s/handover.md, projects/cmr76rvc3008sqk01itxc3o8s/events.jsonl, projects/cmr76rvc3008sqk01itxc3o8s/incidents/incident-replay-<incident-id>.jsonl
- cmr76setn00b1qk016rwy464r: black_box sha256:4ad49dfdb00cec1ad68a3cfa6c5f62e229a5b5bc7530a05d654e1693f2d232a0 (100% complete)
  Transaction: cmr76sbkw00atqk019prwd8lw; proof: n/a
  Export refs: projects/cmr76rvc3008sqk01itxc3o8s/incidents/incident-replay-cmr76setn00b1qk016rwy464r.jsonl, projects/cmr76rvc3008sqk01itxc3o8s/handover.md, projects/cmr76rvc3008sqk01itxc3o8s/events.jsonl, projects/cmr76rvc3008sqk01itxc3o8s/incidents/incident-replay-<incident-id>.jsonl
- cmr76vnbv00gdqk01nrgyvuch: security sha256:a2e1c63ce99f849285a5392f497fc377ce30f8e7c5488beb3910767e0bb16bb6 (36% complete)
  Transaction: cmr76sbkw00atqk019prwd8lw; proof: n/a
  Missing event kinds: transaction.opened, assumption.recorded, clearance.issued, read.observed, write.denied, inspection.result, near_miss.detected, transaction.committed, transaction.aborted
  Export refs: projects/cmr76rvc3008sqk01itxc3o8s/incidents/incident-replay-cmr76vnbv00gdqk01nrgyvuch.jsonl, projects/cmr76rvc3008sqk01itxc3o8s/handover.md
- cmr76ufnq00ehqk01texuuh7z: black_box sha256:0440d3ec904cc611fa4f78850026ddb97d51be44de844762ad252f73b930b531 (100% complete)
  Transaction: cmr76sqte00blqk01jga6jnj3; proof: cmr76z76b00gjqk01x6cwpr50
  Export refs: projects/cmr76rvc3008sqk01itxc3o8s/incidents/incident-replay-cmr76ufnq00ehqk01texuuh7z.jsonl, projects/cmr76rvc3008sqk01itxc3o8s/handover.md, projects/cmr76rvc3008sqk01itxc3o8s/proof-bundles/cmr76z76b00gjqk01x6cwpr50.proof.json, projects/cmr76rvc3008sqk01itxc3o8s/proof-bundles/cmr76z76b00gjqk01x6cwpr50.trailers.txt

## Collision Forecast

Risk level: high
- high: contract_collision in synthi/prisma/**
- high: contract_collision in synthi/prisma/**
- high: contract_collision in synthi/prisma/**
- high: contract_collision in synthi/prisma/**
- high: contract_collision in synthi/prisma/**
- high: contract_collision in synthi/prisma/**
- high: contract_collision in synthi/prisma/**
- high: contract_collision in synthi/prisma/**
- high: contract_collision in synthi/prisma/**
- high: contract_collision in synthi/prisma/**
- medium: restricted_airspace_occupancy in synthi/prisma/**
- high: wake_turbulence in synthi/prisma/**
