import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { LINKS, call, openExternal, type Template } from "../api";
import { Btn, ConfirmButton, FormRow, Group, Page, Row, Select, Sheet, Stepper, stagger, useAction, useRefData, useToast } from "../ui";

const blank = (): Template => ({
  id: 0, name: "", gpu_spec_uuid: "5090-p", gpu_amount: 1, data_center_list: [],
  image_uuid: "base-image-l2t43iu6uk", cuda_v_from: 118, expand_disk_gb: 0, instance_name: null, start_command: null,
});
const CUDA = [113, 117, 118, 121, 124, 128];

export default function TemplatesPage({ hasToken }: { hasToken: boolean }) {
  const ref = useRefData();
  const [list, setList] = useState<Template[]>([]);
  const [edit, setEdit] = useState<Template | null>(null);
  const { busy, run } = useAction();
  const toast = useToast();
  const load = () => call<Template[]>("list_templates").then(setList);
  useEffect(() => { load(); }, []);

  const set = <K extends keyof Template>(k: K, v: Template[K]) => setEdit((e) => (e ? { ...e, [k]: v } : e));
  const spec = (v: string) => ref?.gpu_specs.find((s) => s.value === v)?.label ?? v;
  const image = (v: string) => ref?.base_images.find((s) => s.value === v)?.label ?? v;

  const save = async () => {
    if (!edit) return;
    const r = await run(() => call("save_template", { template: { ...edit, name: edit.name.trim() || spec(edit.gpu_spec_uuid) } }), "模板已保存");
    if (r !== undefined) { setEdit(null); load(); }
  };
  const create = async (t: Template) => {
    const id = await run(() => call<string>("create_from_template", { id: t.id }));
    if (id) toast(`已创建实例 ${id}，到「我的实例」查看开机进度`);
  };

  return (
    <Page>
      <h1 className="title">创建模板</h1>
      <p className="lede">把卡型、镜像和开机命令存起来，之后一键创建实例，或者交给提醒规则在有卡时自动创建。通过 API 创建的实例只能按量计费。</p>
      <div style={{ maxWidth: 720 }}>
        {!hasToken && (
          <Group style={{ marginBottom: 16 }}>
            <Row icon="key" grey label="创建模板只用于容器实例 Pro" sub="需要在「设置 → 容器实例 Pro（可选）」里填写开发者 Token。租普通实例请直接去算力市场。"
              right={<Btn small icon="external" onClick={() => openExternal(LINKS.market)}>算力市场</Btn>} />
          </Group>
        )}
        <Group>
          <motion.div variants={stagger.container} initial="initial" animate="animate">
            {list.map((t) => (
              <motion.div key={t.id} variants={stagger.item}>
                <Row icon="gpu_s" label={<b style={{ fontWeight: 600 }}>{t.name}</b>}
                  sub={`${spec(t.gpu_spec_uuid)} × ${t.gpu_amount}，${image(t.image_uuid)}`} onClick={() => setEdit({ ...t })}
                  right={<span onClick={(e) => e.stopPropagation()}>
                    <ConfirmButton className="btn small primary" icon="power" label="创建" confirmLabel="开始计费，确认？" disabled={busy || !hasToken} onConfirm={() => create(t)} />
                  </span>} />
              </motion.div>
            ))}
          </motion.div>
          {list.length === 0 && <div className="empty-state">还没有模板</div>}
        </Group>
        <div className="row" style={{ marginTop: 18 }}><Btn icon="plus" onClick={() => setEdit(blank())}>新建模板</Btn></div>
      </div>

      <Sheet open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? edit.name : "新建模板"}
        right={<button className="link-btn bold" disabled={busy} onClick={save}>完成</button>}>
        {edit && (
          <>
            <div className="group-label">名称</div>
            <Group>
              <div className="group-row">
                <input className="inline-input" style={{ textAlign: "left" }} value={edit.name} placeholder="留空用卡型命名" aria-label="模板名称"
                  onChange={(e) => set("name", e.target.value)} />
              </div>
            </Group>
            <div className="group-label">硬件</div>
            <Group>
              <FormRow icon="gpu_s" label="卡型">
                <Select label="卡型" value={edit.gpu_spec_uuid} onChange={(v) => set("gpu_spec_uuid", v)}
                  options={(ref?.gpu_specs ?? []).map((o) => ({ value: o.value, label: o.label }))} />
              </FormRow>
              <FormRow icon="number" label="卡数"><Stepper value={edit.gpu_amount} min={1} max={4} unit="张" onChange={(v) => set("gpu_amount", v)} /></FormRow>
              <FormRow icon="box" label="扩容系统盘"><Stepper value={edit.expand_disk_gb} min={0} max={500} step={10} unit="GB" onChange={(v) => set("expand_disk_gb", v)} /></FormRow>
            </Group>
            <div className="group-label">环境</div>
            <Group>
              <FormRow icon="image" label="镜像">
                <input className="inline-input" list="images" value={edit.image_uuid} onChange={(e) => set("image_uuid", e.target.value)} />
                <datalist id="images">{ref?.base_images.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</datalist>
              </FormRow>
              <FormRow icon="cube" label="最低 CUDA">
                <Select label="最低 CUDA" value={edit.cuda_v_from} onChange={(v) => set("cuda_v_from", v)}
                  options={CUDA.map((c) => ({ value: c, label: `CUDA ${(c / 10).toFixed(1)}` }))} />
              </FormRow>
            </Group>
            <div className="group-foot">{image(edit.image_uuid)}。也可以直接填私有镜像的 image_uuid。</div>
            <div className="group-label">区域（都不选则自动选择）</div>
            <Group>
              {ref?.pro_regions.map((o) => {
                const on = edit.data_center_list.includes(o.value);
                return (
                  <Row key={o.value} icon="pin" grey={!on} label={o.label}
                    onClick={() => set("data_center_list", on ? edit.data_center_list.filter((x) => x !== o.value) : [...edit.data_center_list, o.value])}
                    right={on ? <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} style={{ color: "var(--blue)", fontWeight: 700 }}>✓</motion.span> : null} />
                );
              })}
            </Group>
            <div className="group-label">开机后</div>
            <Group>
              <FormRow icon="text" label="备注名">
                <input className="inline-input" value={edit.instance_name ?? ""} placeholder="可选" onChange={(e) => set("instance_name", e.target.value || null)} />
              </FormRow>
            </Group>
            <textarea className="field-input" rows={3} style={{ marginTop: 12 }} value={edit.start_command ?? ""} aria-label="开机命令"
              placeholder="开机命令，如 cd /root/autodl-tmp && python train.py" onChange={(e) => set("start_command", e.target.value || null)} />
            <div className="group-foot">开机后自动执行；执行失败不会关机。</div>
            {edit.id > 0 && (
              <div style={{ marginTop: 24, display: "flex", justifyContent: "center" }}>
                <ConfirmButton icon="trash" label="删除模板" onConfirm={async () => {
                  await run(() => call("delete_template", { id: edit.id }), "模板已删除"); setEdit(null); load();
                }} />
              </div>
            )}
          </>
        )}
      </Sheet>
    </Page>
  );
}
