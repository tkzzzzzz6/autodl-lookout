import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { LINKS, call, fmtTime, openExternal, regionOptions, type Rule, type RuleAction, type Snapshot, type Template } from "../api";
import { Icon, type IconName } from "../icons";
import { Btn, ConfirmButton, FormRow, Group, Page, Row, Segmented, Select, Sheet, Stepper, Switch, numOrNull, stagger, useAction, useRefData } from "../ui";

const blank = (): Rule => ({
  id: 0, name: "", enabled: true, region_sign: "westDC3", gpu_keyword: "", min_idle: 1, cuda_v_from: null,
  max_price_yuan: null, cooldown_minutes: 15, action: "notify", template_id: null, instance_uuid: null,
  daily_limit: 1, last_fired_at: null, min_per_machine: 1,
});

const ACTION_ICON: Record<RuleAction, IconName> = { notify: "bell", create: "plus_sq", power_on: "power" };
const CUDA = [null, 113, 117, 118, 121, 124, 128];
const COOLDOWN = [0, 5, 10, 15, 30, 60, 120];

export default function RulesPage({ snap }: { snap: Snapshot | null }) {
  const ref = useRefData();
  const [rules, setRules] = useState<Rule[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [edit, setEdit] = useState<Rule | null>(null);
  const { busy, run } = useAction();

  const load = () => call<Rule[]>("list_rules").then(setRules);
  useEffect(() => { load(); call<Template[]>("list_templates").then(setTemplates); }, []);

  const regionName = (s: string) => ref?.regions.find((r) => r.value === s)?.label ?? s;
  const state = (id: number) => snap?.rules.find((r) => r.rule_id === id);
  const set = <K extends keyof Rule>(k: K, v: Rule[K]) => setEdit((e) => (e ? { ...e, [k]: v } : e));

  const describe = (r: Rule) => {
    const bits = [r.min_per_machine > 1 ? `单机 ≥ ${r.min_per_machine} 卡` : `空闲 ≥ ${r.min_idle}`];
    if (r.max_price_yuan != null) bits.push(`≤ ¥${r.max_price_yuan}/时`);
    if (r.cuda_v_from != null) bits.push(`CUDA ≥ ${(r.cuda_v_from / 10).toFixed(1)}`);
    bits.push(r.action === "notify" ? `冷却 ${r.cooldown_minutes} 分钟` : r.action === "create" ? "有卡后自动创建实例" : "有卡后自动开机");
    return bits.join("，");
  };

  const save = async () => {
    if (!edit) return;
    const r = { ...edit, name: edit.name.trim() || `${regionName(edit.region_sign)} ${edit.gpu_keyword.trim()}` };
    const ok = await run(() => call("save_rule", { rule: r }), edit.id ? "规则已更新" : "规则已添加");
    if (ok !== undefined) { setEdit(null); load(); }
  };
  const toggle = async (r: Rule, enabled: boolean) => {
    setRules((rs) => rs.map((x) => (x.id === r.id ? { ...x, enabled } : x))); // 先动开关，再存
    await run(() => call("save_rule", { rule: { ...r, enabled } }));
    load();
  };
  const remove = async (r: Rule) => {
    await run(() => call("delete_rule", { id: r.id }), "规则已删除");
    setEdit(null); load();
  };

  return (
    <Page>
      <h1 className="title">提醒规则</h1>
      <p className="lede">有卡时推送通知。同一条规则提醒过后，冷却时间内不会再提醒。</p>
      <div style={{ maxWidth: 640 }}>
        <Group>
          <motion.div variants={stagger.container} initial="initial" animate="animate">
            {rules.map((r) => {
              const s = state(r.id);
              const cap = !r.enabled ? <span className="capsule">已停用</span>
                : s?.error ? <span className="capsule err" title={s.error}>查询失败</span>
                : s?.hit ? <motion.span className="capsule on num" initial={{ scale: .8 }} animate={{ scale: 1 }}>{r.min_per_machine > 1 && s.machines != null ? `${s.machines} 台可开 ${r.min_per_machine} 卡` : `有 ${s.idle_sum} 张`}</motion.span>
                : s ? <span className="capsule">没有</span> : <span className="capsule">等待</span>;
              return (
                <motion.div key={r.id} variants={stagger.item}>
                  <Row icon={ACTION_ICON[r.action]} grey={!r.enabled} label={<b style={{ fontWeight: 600 }}>{r.name}</b>} dim={!r.enabled}
                    sub={describe(r)} selected={edit?.id === r.id} onClick={() => setEdit({ ...r })}
                    right={<span className="row" style={{ gap: 12, flexWrap: "nowrap" }}>{cap}
                      {r.enabled && s?.hit && (
                        <button className="icon-btn" title="去算力市场租" aria-label={`去算力市场租 ${r.name}`}
                          onClick={(e) => { e.stopPropagation(); openExternal(s.market_url || LINKS.market); }}>
                          <Icon name="external" size={16} stroke={2} />
                        </button>
                      )}
                      <Switch checked={r.enabled} label={`启用 ${r.name}`} onChange={(v) => toggle(r, v)} /></span>} />
                </motion.div>
              );
            })}
            {rules.length === 0 && <div className="empty-state">还没有规则，点下面「新建规则」</div>}
          </motion.div>
        </Group>
        <div className="row" style={{ marginTop: 18 }}>
          <Btn icon="plus" onClick={() => setEdit(blank())}>新建规则</Btn>
        </div>
      </div>

      <Sheet open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? edit.name : "新建规则"}
        right={<button className="link-btn bold" disabled={busy || !edit?.gpu_keyword.trim()} onClick={save}>完成</button>}>
        {edit && (
          <>
            <div className="group-label">名称</div>
            <Group>
              <div className="group-row">
                <input className="inline-input" style={{ textAlign: "left" }} value={edit.name} placeholder="留空自动生成，如「西北B区 4090」"
                  onChange={(e) => set("name", e.target.value)} aria-label="规则名称" />
              </div>
            </Group>

            <div className="group-label">条件</div>
            <Group>
              <FormRow icon="pin" label="区域">
                <Select label="区域" value={edit.region_sign} onChange={(v) => set("region_sign", v)} options={regionOptions(ref?.regions ?? [])} />
              </FormRow>
              <FormRow icon="gpu_s" label="卡型关键字">
                <input className="inline-input" value={edit.gpu_keyword} placeholder="如 4090" onChange={(e) => set("gpu_keyword", e.target.value)} />
              </FormRow>
              <FormRow icon="number" label="空闲至少">
                <Stepper value={edit.min_idle} min={1} max={64} unit="张" onChange={(v) => set("min_idle", v)} />
              </FormRow>
              <FormRow icon="server" label="单机至少">
                <Stepper value={edit.min_per_machine} min={1} max={8} unit="卡" onChange={(v) => set("min_per_machine", v)} />
              </FormRow>
            </Group>
            <div className="group-foot">
              {edit.min_per_machine > 1
                ? `只统计单台机器同时空出 ${edit.min_per_machine} 张卡的情况，适合多卡训练；「空闲至少」按这些机器的空闲卡数加总。`
                : "「单机至少」为 1 时按整个区域的空闲总数判断；跑多卡训练时调大它。"}
            </div>
            <div className="group-foot">关键字不区分大小写，「4090」会同时匹配 RTX 4090 和 RTX 4090D。</div>

            <div className="group-label">筛选</div>
            <Group>
              <FormRow icon="yen" label="单价上限">
                <input className="inline-input" type="number" step="0.1" min="0" placeholder="不限" style={{ maxWidth: 90 }}
                  value={edit.max_price_yuan ?? ""} onChange={(e) => set("max_price_yuan", numOrNull(e.target.value))} />
                <span className="muted" style={{ marginLeft: 6 }}>元/时</span>
              </FormRow>
              <FormRow icon="cube" label="最低 CUDA">
                <Select label="最低 CUDA" value={edit.cuda_v_from} onChange={(v) => set("cuda_v_from", v)}
                  options={CUDA.map((c) => ({ value: c, label: c == null ? "不限" : `CUDA ${(c / 10).toFixed(1)}`, sub: c == null ? undefined : "机器驱动支持的最高版本不低于它" }))} />
              </FormRow>
              <FormRow icon="timer" label="冷却时间">
                <Select label="冷却时间" value={edit.cooldown_minutes} onChange={(v) => set("cooldown_minutes", v)}
                  options={COOLDOWN.map((m) => ({ value: m, label: m === 0 ? "不冷却" : m >= 60 ? `${m / 60} 小时` : `${m} 分钟`, sub: m === 0 ? "每次查询有卡都提醒" : undefined }))} />
              </FormRow>
            </Group>

            <div className="group-label">有卡后</div>
            <Segmented full layoutId="rule-action" value={edit.action} onChange={(v) => set("action", v)}
              items={[{ id: "notify", label: "只提醒", icon: "bell" }, { id: "create", label: "自动创建", icon: "plus_sq" }, { id: "power_on", label: "自动开机", icon: "power" }]} />
            {edit.action !== "notify" && (
              <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} key={edit.action}>
                <Group style={{ marginTop: 12 }}>
                  {edit.action === "create" ? (
                    <FormRow icon="doc" label="创建模板">
                      <Select label="创建模板" value={edit.template_id} onChange={(v) => set("template_id", v)} placeholder={templates.length ? "请选择" : "还没有模板"}
                        options={templates.map((t) => ({ value: t.id as number | null, label: t.name }))} />
                    </FormRow>
                  ) : (
                    <FormRow icon="server" label="实例 ID">
                      <input className="inline-input" value={edit.instance_uuid ?? ""} placeholder="pro-xxxxxxxx" onChange={(e) => set("instance_uuid", e.target.value)} />
                    </FormRow>
                  )}
                  <FormRow icon="calendar" label="每天最多">
                    <Stepper value={edit.daily_limit} min={0} max={20} unit="次" onChange={(v) => set("daily_limit", v)} />
                  </FormRow>
                </Group>
                <div className="group-foot">
                  {!snap?.has_token && <span className="err-text">自动创建 / 开机只支持容器实例 Pro，需要先在「设置」里填写开发者 Token，否则只会提醒。</span>}
                  余额低于「设置」里的下限时不会执行。按量计费，开机即开始扣费。
                </div>
              </motion.div>
            )}

            <div className="group-label">状态</div>
            <Group>
              <FormRow icon="check" label="启用这条规则">
                <Switch checked={edit.enabled} label="启用" onChange={(v) => set("enabled", v)} />
              </FormRow>
            </Group>
            {edit.last_fired_at && <div className="group-foot">上次提醒：{fmtTime(edit.last_fired_at)}</div>}

            {edit.id > 0 && (
              <div style={{ marginTop: 24, display: "flex", justifyContent: "center" }}>
                <ConfirmButton icon="trash" label="删除规则" onConfirm={() => remove(edit)} />
              </div>
            )}
          </>
        )}
      </Sheet>
    </Page>
  );
}
