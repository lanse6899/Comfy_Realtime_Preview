# ImagePreviewNode - ComfyUI 图像实时预览插件

一个强大的 ComfyUI 插件，提供图像实时预览功能，支持在节点下方实时显示图像预览，无需重复运行队列即可看到效果变化。
说明视频：https://www.bilibili.com/video/BV19k1HBAEyL/

PS：商用平台方使用请知会一声哈！

### 🚀 实时预览
- **即时显示**：首次运行队列时，节点自动显示图像预览
- **持久预览**：图像预览会一直保持，无需重新运行队列
- **实时同步**：支持5个上游节点参数变化时，预览自动实时更新(注意5个上游节点为最多，1个上游节点时延迟最低)

### 🎨 智能图像处理
- **前端实时计算**：支持亮度、对比度、饱和度、色相、曝光、锐化、色温、调色等常见图像处理
- **智能参数识别**：自动识别并处理各种图像处理节点

## 📦 安装

1. 将 `ImagePreviewNode` 文件夹复制到 ComfyUI 的 `custom_nodes` 目录下
2. 重启 ComfyUI

```bash
# 示例路径（Windows）
C:\ComfyUI\custom_nodes\ImagePreviewNode


## 🎯 使用方法

### 基础使用

1. 在 ComfyUI 界面中，找到 `🔵BB ImagePreview` 分类
2. 添加 `图像实时预览` 节点
3. 将图像连接到该节点的输入端口
4. 运行队列，图像会自动显示在节点下方

### 实时同步功能

当你在上游连接图像处理节点时：

1. **首次运行**：运行队列后，图像会在预览节点中显示
2. **实时调整**：调整上游节点的参数（如亮度、对比度滑块）时，预览会**实时同步更新**
3. **无需重新运行**：无需重新运行队列即可看到效果变化

## 🎨 支持的节点类型

自动识别并处理各种图像处理节点。

例如：
| **亮度对比度** | BrightnessContrast, ImageBrightnessContrast |
| **亮度** | Brightness |
| **对比度** | Contrast |
| **饱和度** | Saturation, ImageSaturation |
| **色相** | Hue, ImageHue |
| **曝光** | Exposure, ImageExposure |
| **锐化** | Sharpen, SharpenImage, ImageSharpen |
| **色温** | ColorTemperature, Temperature |
| **色调/Tint** | Tint, ColorTint |
| **高光/阴影** | Highlights, Shadows, HighlightsShadows |

### 预览不显示

1. 检查节点是否正确连接到图像输出
2. 确保已运行队列至少一次
3. 检查浏览器控制台是否有错误信息
4. 重启 ComfyUI 尝试

### 实时更新不工作

1. 确保上游节点参数有变化
2. 检查上游节点是否支持实时预览
3. 查看浏览器控制台的错误信息

### 性能问题

1. 如果预览更新较慢，可以降低图像质量
2. 如果卡顿，可能是上游节点过多，建议减少预览节点数量

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 许可证

本项目采用 MIT 许可证。

