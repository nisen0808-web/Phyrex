console.log('V1 UI loaded');
const V1_FACES=['清秀','俊朗','英武','冷峻','温润','疏朗'];
const V1_BODY=['瘦削','匀称','健壮','修长','魁梧'];
const V1_AURA=['平和','沉稳','冷淡','洒脱','谨慎'];
const V1_ROOT=['杂灵根','三灵根','双灵根','单灵根','天灵根'];
function v1Pick(a){return a[Math.floor(Math.random()*a.length)]}
function v1Profile(a){if(!a)return;a.gender=a.gender||v1Pick(['男','女']);a.face=a.face||v1Pick(V1_FACES);a.body=a.body||v1Pick(V1_BODY);a.aura=a.aura||v1Pick(V1_AURA);a.root=a.root||v1Pick(V1_ROOT);a.charm=a.charm||randInt(35,90);a.bone=a.bone||randInt(35,90);a.wisdom=a.wisdom||randInt(35,90)}
function v1PatchWorld(){state.actors.forEach(v1Profile);const p=findActor('player');if(p&&!state.v1Init){p.realm=0;p.exp=0;p.qi=47;p.maxQi=100;p.lifespan=82;p.wealth=44;p.sect='无门派';p.location='starter_village';p.origin='新手村';state.v1Init=true;saveWorld()}}
const v1OldRenderWorld=renderWorld;
renderWorld=function(){v1PatchWorld();const alive=state.actors.filter(a=>a.alive).length;const dead=state.actors.length-alive;const p=findActor('player');el.worldDate.textContent=`第 ${state.year} 年 ${getSeason(state)} 第 ${state.day} 日`;el.worldSub.textContent=`存活 ${alive} 人｜死亡 ${dead} 人｜长期命令 ${state.orders.length} 条｜门派：${p.sect}｜灵石：${p.wealth}｜修为：${REALM_NAMES[p.realm]}｜气血：${p.hp}/${p.maxHp}｜灵气：${p.qi}/${p.maxQi}`};
v1PatchWorld();