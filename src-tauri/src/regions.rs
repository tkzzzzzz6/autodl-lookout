//! Static reference data from the AutoDL docs.

use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct Opt {
    pub value: &'static str,
    pub label: &'static str,
}

/// 区域（代码沿用 data_center，对应控制台 /api/v1/region/list 里的 data_center 字段）
/// 顺序与控制台算力市场一致
pub const REGIONS: &[Opt] = &[
    Opt { value: "westDC3", label: "西北B区" },
    Opt { value: "beijingDC2", label: "北京B区" },
    Opt { value: "chongqingDC1", label: "重庆A区" },
    Opt { value: "neimengDC3", label: "内蒙B区" },
    Opt { value: "beijingDC1", label: "北京A区" },
    Opt { value: "foshanDC1", label: "佛山区" },
    Opt { value: "beijingDC3", label: "V100专区" },
    Opt { value: "neimengDC2", label: "A800专区" },
    Opt { value: "shanghaiDC1", label: "摩尔线程专区" },
    Opt { value: "westDC2", label: "西北企业区" },
];

/// 容器实例 Pro 创建时可选的区域
pub const PRO_REGIONS: &[Opt] = &[
    Opt { value: "westDC3", label: "西北B区" },
    Opt { value: "beijingDC2", label: "北京B区" },
];

/// 容器实例 Pro 的 gpu_spec_uuid
pub const GPU_SPECS: &[Opt] = &[
    Opt { value: "5090-p", label: "5090-32G 性能型" },
    Opt { value: "4090D", label: "4090D 通用型" },
    Opt { value: "v-48g", label: "4090-48G 通用型" },
    Opt { value: "v-32g-p", label: "4080(S)-32G 性能型" },
    Opt { value: "v-48g-350w", label: "3090-48G 通用型" },
    Opt { value: "pro6000-p", label: "PRO6000-96G 性能型" },
    Opt { value: "h800", label: "H800-80G 通用型" },
];

/// 公共基础镜像（Pro API 附录）
pub const BASE_IMAGES: &[Opt] = &[
    Opt { value: "base-image-l2t43iu6uk", label: "PyTorch 2.0.0 · CUDA 11.8 · Py3.8" },
    Opt { value: "base-image-l374uiucui", label: "PyTorch 1.11.0 · CUDA 11.3 · Py3.8" },
    Opt { value: "base-image-u9r24vthlk", label: "PyTorch 1.10.0 · CUDA 11.3 · Py3.8" },
    Opt { value: "base-image-12be412037", label: "PyTorch 1.9.0 · CUDA 11.1 · Py3.8" },
    Opt { value: "base-image-uxeklgirir", label: "TensorFlow 2.9.0 · CUDA 11.2 · Py3.8" },
    Opt { value: "base-image-0gxqmciyth", label: "TensorFlow 2.5.0 · CUDA 11.2 · Py3.8" },
    Opt { value: "base-image-4bpg0tt88l", label: "TensorFlow 1.15.5 · CUDA 11.4 · Py3.8" },
    Opt { value: "base-image-mbr2n4urrc", label: "Miniconda · CUDA 11.6 · Py3.8" },
    Opt { value: "base-image-7bn8iqhkb5", label: "Miniconda · CUDA 11.3 · Py3.8" },
    Opt { value: "base-image-h041hn36yt", label: "Miniconda · CUDA 11.1 · Py3.8" },
    Opt { value: "base-image-qkkhitpik5", label: "Miniconda · CUDA 10.2 · Py3.8" },
    Opt { value: "base-image-l2843iu23k", label: "TensorRT 8.5.1 · CUDA 11.8 · Py3.8" },
];

pub fn region_name(sign: &str) -> String {
    REGIONS.iter().find(|r| r.value == sign).map(|r| r.label.to_string()).unwrap_or_else(|| sign.to_string())
}

#[derive(Serialize)]
pub struct RefData {
    pub regions: &'static [Opt],
    pub pro_regions: &'static [Opt],
    pub gpu_specs: &'static [Opt],
    pub base_images: &'static [Opt],
}

pub fn ref_data() -> RefData {
    RefData { regions: REGIONS, pro_regions: PRO_REGIONS, gpu_specs: GPU_SPECS, base_images: BASE_IMAGES }
}
