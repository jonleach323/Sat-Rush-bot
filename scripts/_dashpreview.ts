import { MonitorApi } from "../src/ops/api.js";
import type { MonitorData } from "../src/ops/monitor.js";
const stakes = new Array(21).fill(0).map((_,i)=> [0,3].includes(i)?2.3 : i===11?9.1 : (i%4===0?1.2:0));
const data: MonitorData = {
  status: () => ({ ts:new Date().toISOString(), mode:"mainnet", paused:false, killSwitch:false,
    ingest:{fresh:true,slotAgeMs:180,source:"yellowstone-grpc"},
    round:{id:428,state:"Active",slotsToCutoff:22,currentSlot:436830000},
    board:{tileStakesUsd:stakes,totalUsd:stakes.reduce((a,b)=>a+b,0),strikePoolUsd:1284.5},
    me:{streak:14,tiles:[0,3],stakeUsd:4.6},
    pnl:{todayNetUsd:37.4,deployedTodayUsd:220,returnedTodayUsd:257.4},
    unclaimed:{usd:41.2,shares:"193790"},
    caps:{maxPerRoundUsd:1000,dailyLossCapUsd:1000,dailyLossLeftUsd:1000} }),
  pnlDaily: () => ({date:"2026-08-02"}),
  recentRounds: (n) => Array.from({length:Math.min(n,12)},(_,i)=>({id:428-i,winning_tile:(i*3+1)%21,deployed_usd:String((6+i)*1e6),miners_count:2+i%4,strike_triggered:i===3?1:0})),
  recentDeploys: (n) => Array.from({length:Math.min(n,8)},(_,i)=>({round_id:428-i,mask:i%2?1:9,amount:"4600000",status:i%3===2?"missed":"landed",fired_slot:1000,landed_slot:i%3===2?null:1001})),
  recentCompetitors: (n) => Array.from({length:Math.min(n,10)},(_,i)=>({round_id:428-i,authority:"Ab"+i+"CdEfGhJkMnPqRsTuVwXyZ1234567890abcd",amount:String((5+i)*1e6),total_stake:String((4.6+i)*1e6),is_automation:i%2,slot:436829000+i})),
  health: async () => ({ingestFresh:true,ingestSlotAgeMs:180,solBalance:0.42,usdcBalance:4958.8,dbError:null}),
};
const api = new MonitorApi({ token:"demo", host:"127.0.0.1", port:8805, data, mode:"mainnet", startedAtMs:Date.now() });
await api.start();
console.log("ready");
