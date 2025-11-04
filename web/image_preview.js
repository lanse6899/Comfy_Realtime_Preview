import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// 优化：全局预览节点缓存，避免频繁遍历所有节点（解决卡顿问题）
const previewNodeCache = new Map(); // upstreamNodeId -> Set<previewNodes>

// 优化：获取监听特定上游节点的预览节点（使用缓存，避免遍历）
function getPreviewNodesForUpstream(upstreamNodeId) {
    if (!previewNodeCache.has(upstreamNodeId)) {
        previewNodeCache.set(upstreamNodeId, new Set());
    }
    return previewNodeCache.get(upstreamNodeId);
}

// 优化：注册预览节点到缓存
function registerPreviewNode(previewNode, upstreamNodeId) {
    if (upstreamNodeId) {
        const nodeSet = getPreviewNodesForUpstream(upstreamNodeId);
        nodeSet.add(previewNode);
    }
}

// 优化：从缓存中移除预览节点
function unregisterPreviewNode(previewNode, upstreamNodeId) {
    if (upstreamNodeId) {
        const nodeSet = previewNodeCache.get(upstreamNodeId);
        if (nodeSet) {
            nodeSet.delete(previewNode);
            if (nodeSet.size === 0) {
                previewNodeCache.delete(upstreamNodeId);
            }
        }
    }
}

app.registerExtension({
    name: "ImagePreviewNode.Preview",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name === "ImagePreviewNode") {

            // 扩展节点的构造函数
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function() {
                const result = onNodeCreated?.apply(this, arguments);
                
                // 设置组件起始位置，确保在端口下方
                this.widgets_start_y = 30;
                
                // 初始化上游节点监听器
                this.upstreamListeners = new Map();
                this.updateThrottle = null;
                this.backendThrottle = null;
                this.lastBackendParams = null;
                this.isDragging = false; // 标记是否正在拖动
                this.dragTimeout = null; // 拖动超时定时器
                this.pendingBackendCall = null; // 待执行的后端调用
                this.dragBackendThrottle = null; // 拖动时的后端调用节流器
                
                // 设置WebSocket监听
                this.setupWebSocket();
                
                // 设置上游节点监听
                this.setupUpstreamListener();
                
                return result;
            };
            
            // 获取连接的输入节点
            nodeType.prototype.getConnectedNode = function(slot = 0) {
                if (this.inputs && this.inputs[slot] && this.inputs[slot].link) {
                    const link = app.graph.links[this.inputs[slot].link];
                    if (link) {
                        return app.graph.getNodeById(link.origin_id);
                    }
                }
                return null;
            };
            
            // 设置上游节点监听
            nodeType.prototype.setupUpstreamListener = function() {
                // 优化：使用requestAnimationFrame延迟执行，避免阻塞主线程
                // 延迟执行，确保节点已完全创建
                requestAnimationFrame(() => {
                    setTimeout(() => {
                        this.checkUpstreamNodes();
                    }, 50); // 减少延迟时间
                });
                
                // 监听连接变化
                const onConnectionsChange = this.onConnectionsChange;
                this.onConnectionsChange = function(type, index, connected, link_info) {
                    const result = onConnectionsChange?.apply(this, arguments);
                    
                    if (type === LiteGraph.INPUT && index === 0) {
                        // 连接变化时重新检查上游节点
                        requestAnimationFrame(() => {
                            setTimeout(() => {
                                this.checkUpstreamNodes();
                            }, 50); // 减少延迟时间
                        });
                    }
                    
                    return result;
                };
            };
            
            // 检查并监听上游节点
            nodeType.prototype.checkUpstreamNodes = function() {
                const upstreamNode = this.getConnectedNode(0);
                
                // 清理之前的缓存注册
                if (this.lastUpstreamNodeId && this.lastUpstreamNodeId !== upstreamNode?.id) {
                    unregisterPreviewNode(this, this.lastUpstreamNodeId);
                }
                
                if (!upstreamNode) {
                    // 清除之前的监听器
                    this.clearUpstreamListeners();
                    this.lastUpstreamNodeId = null;
                    return;
                }
                
                // 如果已经监听了这个节点，跳过
                if (this.upstreamListeners.has(upstreamNode.id)) {
                    // 确保缓存注册
                    if (this.lastUpstreamNodeId !== upstreamNode.id) {
                        registerPreviewNode(this, upstreamNode.id);
                        this.lastUpstreamNodeId = upstreamNode.id;
                    }
                    return;
                }
                
                console.log(`[ImagePreview] 节点 ${this.id} 开始监听上游节点 ${upstreamNode.id} (${upstreamNode.type})`);
                
                // 注册到缓存
                registerPreviewNode(this, upstreamNode.id);
                this.lastUpstreamNodeId = upstreamNode.id;
                
                // 监听上游节点的参数变化
                this.setupNodeListener(upstreamNode);
            };
            
            // 为特定节点设置监听
            nodeType.prototype.setupNodeListener = function(upstreamNode) {
                const nodeId = upstreamNode.id;
                const self = this;
                
                // 保存原始widget callbacks
                const originalCallbacks = new Map();
                
                // 监听 widget 值变化
                if (upstreamNode.widgets) {
                    upstreamNode.widgets.forEach(widget => {
                        // 保存原始callback
                        if (widget.callback) {
                            originalCallbacks.set(widget.name, widget.callback);
                        }
                        
                        // 包装callback
                        const originalCallback = widget.callback;
                        
                        // 检测拖动开始和结束
                        if (widget.widget) {
                            const originalDragStart = widget.widget.onDragStart;
                            const originalDragEnd = widget.widget.onDragEnd;
                            
                            widget.widget.onDragStart = function() {
                                originalDragStart?.apply(this, arguments);
                                
                                // 优化：使用缓存直接获取预览节点，避免遍历所有节点
                                const previewNodes = getPreviewNodesForUpstream(upstreamNode.id);
                                previewNodes.forEach(node => {
                                    if (node && !node.removed) {
                                        node.isDragging = true;
                                        // 清除拖动时的后端调用节流器
                                        if (node.dragBackendThrottle) {
                                            clearTimeout(node.dragBackendThrottle);
                                            node.dragBackendThrottle = null;
                                        }
                                        // 取消待执行的后端调用
                                        if (node.pendingBackendCall) {
                                            clearTimeout(node.pendingBackendCall);
                                            node.pendingBackendCall = null;
                                        }
                                    }
                                });
                            };
                            
                            widget.widget.onDragEnd = function() {
                                originalDragEnd?.apply(this, arguments);
                                
                                // 优化：使用缓存直接获取预览节点，避免遍历所有节点
                                const previewNodes = getPreviewNodesForUpstream(upstreamNode.id);
                                previewNodes.forEach(node => {
                                    if (node && !node.removed) {
                                        node.isDragging = false;
                                        // 清除拖动时的后端调用节流器
                                        if (node.dragBackendThrottle) {
                                            clearTimeout(node.dragBackendThrottle);
                                            node.dragBackendThrottle = null;
                                        }
                                        // 执行待执行的后端调用（如果有）
                                        if (node.pendingBackendCall) {
                                            const params = node.pendingBackendCall.params;
                                            const upstream = node.pendingBackendCall.upstreamNode;
                                            node.pendingBackendCall = null;
                                            node.processInBackend(upstream, params, false); // 拖动结束，使用正常节流
                                        }
                                    }
                                });
                            };
                        }
                        
                        widget.callback = function(value) {
                            // 执行原始callback
                            const result = originalCallback?.apply(this, arguments);
                            
                            // 优化：使用缓存直接获取预览节点，避免遍历所有节点
                            const previewNodes = getPreviewNodesForUpstream(upstreamNode.id);
                            previewNodes.forEach(node => {
                                if (node && !node.removed && node.originalImageData) {
                                    node.onUpstreamWidgetChanged(upstreamNode, widget.name, value);
                                }
                            });
                            
                            return result;
                        };
                    });
                }
                
                // 优化：移除轮询机制，完全依赖事件驱动（避免大量定时器导致卡顿）
                // 保存监听器引用
                this.upstreamListeners.set(nodeId, {
                    node: upstreamNode,
                    originalCallbacks: originalCallbacks,
                    pollInterval: null // 不再使用轮询
                });
            };
            
            // 清除上游节点监听器
            nodeType.prototype.clearUpstreamListeners = function() {
                // 从缓存中移除
                if (this.lastUpstreamNodeId) {
                    unregisterPreviewNode(this, this.lastUpstreamNodeId);
                    this.lastUpstreamNodeId = null;
                }
                
                this.upstreamListeners.forEach((listener, nodeId) => {
                    // 清除轮询（已移除，但保留检查以防遗留）
                    if (listener.pollInterval) {
                        clearInterval(listener.pollInterval);
                    }
                    
                    // 恢复原始callbacks
                    const node = app.graph.getNodeById(nodeId);
                    if (node && node.widgets && listener.originalCallbacks) {
                        node.widgets.forEach(widget => {
                            const originalCallback = listener.originalCallbacks.get(widget.name);
                            if (originalCallback) {
                                widget.callback = originalCallback;
                            }
                        });
                    }
                });
                this.upstreamListeners.clear();
            };
            
            // 上游节点变化时的处理
            nodeType.prototype.onUpstreamNodeChanged = function(upstreamNode) {
                if (!this.originalImageData) {
                    return;
                }
                
                // 节流处理，避免频繁更新
                if (this.updateThrottle) {
                    clearTimeout(this.updateThrottle);
                }
                
                this.updateThrottle = setTimeout(() => {
                    this.processUpstreamNode(upstreamNode);
                }, 30); // 30ms 节流（优化：减少延迟）
            };
            
            // 上游 widget 变化时的处理
            nodeType.prototype.onUpstreamWidgetChanged = function(upstreamNode, widgetName, value) {
                if (!this.originalImageData) {
                    return;
                }
                
                // 如果没有传入节点，重新获取
                if (!upstreamNode) {
                    upstreamNode = this.getConnectedNode(0);
                }
                
                if (!upstreamNode) {
                    return;
                }
                
                // 如果正在拖动，同时使用前端快速预览和后端处理
                if (this.isDragging) {
                    const params = this.extractNodeParams(upstreamNode);
                    
                    // 立即应用前端快速预览（无延迟，保证即时响应）
                    requestAnimationFrame(() => {
                        const inferredProcessor = this.inferProcessorFromParams(params);
                        if (inferredProcessor) {
                            this.processInFrontend(params, inferredProcessor);
                        } else {
                            // 如果无法推断，尝试通用处理
                            const genericProcessor = this.createGenericProcessor(params);
                            if (genericProcessor) {
                                this.processInFrontend(params, genericProcessor);
                            } else {
                                // 最后显示原始图像
                                this.updatePreview();
                            }
                        }
                    });
                    
                    // 同时启动后端调用（使用较短的节流时间，拖动时也调用后端）
                    // 清除之前的拖动后端节流器
                    if (this.dragBackendThrottle) {
                        clearTimeout(this.dragBackendThrottle);
                    }
                    
                    // 使用较短的节流时间（200ms），拖动时也调用后端
                    this.dragBackendThrottle = setTimeout(async () => {
                        try {
                            // 更新待执行的后端调用参数
                            this.pendingBackendCall = {
                                upstreamNode: upstreamNode,
                                params: params
                            };
                            // 拖动时也调用后端，使用较短的节流时间
                            await this.processInBackend(upstreamNode, params, true); // true表示拖动中
                        } catch (error) {
                            console.error('[ImagePreview] 拖动时后端处理出错:', error);
                        }
                    }, 200); // 拖动时使用200ms节流，比正常500ms更频繁
                    
                    return;
                }
                
                // 节流处理
                if (this.updateThrottle) {
                    clearTimeout(this.updateThrottle);
                }
                
                this.updateThrottle = setTimeout(() => {
                    this.processUpstreamNode(upstreamNode);
                }, 30); // 30ms 节流（优化：减少延迟）
            };
            
            // 处理上游节点的图像处理
            nodeType.prototype.processUpstreamNode = function(upstreamNode) {
                if (!this.originalImageData || !this.canvas) {
                    return;
                }
                
                // 获取节点类型（尝试多种方式）
                const nodeTypeName = upstreamNode.type || upstreamNode.comfyClass || upstreamNode.title || "";
                const params = this.extractNodeParams(upstreamNode);
                
                console.log(`[ImagePreview] 处理上游节点 ${upstreamNode.id} (${nodeTypeName})`, params);
                
                // 根据节点类型选择处理方式
                const processor = this.getNodeProcessor(nodeTypeName, params);
                
                // 对于所有节点，优先尝试调用后端API（真正执行节点函数）
                // 这样可以获得节点真实的处理效果，而不是模拟
                console.log(`[ImagePreview] 直接使用后端API处理节点: ${nodeTypeName}，确保使用节点真实算法`);
                this.processInBackend(upstreamNode, params);
                
                // 如果前端有已知处理器，也可以同时处理（作为快速预览）
                // 但后端处理是主要方式，确保准确性
                if (processor) {
                    // 前端处理作为快速预览（可选）
                    // this.processInFrontend(params, processor);
                }
            };
            
            // 提取节点参数
            nodeType.prototype.extractNodeParams = function(node) {
                const params = {};
                
                if (node.widgets) {
                    node.widgets.forEach(widget => {
                        if (widget.value !== undefined && widget.name) {
                            // 使用widget.name作为键（支持中文）
                            params[widget.name] = widget.value;
                        }
                    });
                }
                
                // 调试信息
                if (Object.keys(params).length > 0) {
                    console.log(`[ImagePreview] 提取节点参数:`, params);
                }
                
                return params;
            };
            
            // 获取节点处理器
            nodeType.prototype.getNodeProcessor = function(nodeType, params) {
                // 节点类型到处理函数的映射（支持大小写不敏感匹配）
                const nodeTypeLower = nodeType.toLowerCase();
                
                const processors = {
                    // 亮度对比度节点（常见命名）
                    "brightnesscontrast": (params, imageData) => this.applyBrightnessContrast(imageData, params),
                    "imagebrightnesscontrast": (params, imageData) => this.applyBrightnessContrast(imageData, params),
                    "coloradjustment": (params, imageData) => this.applyColorAdjustment(imageData, params),
                    "颜色调整": (params, imageData) => this.applyColorAdjustment(imageData, params),
                    
                    // 饱和度节点
                    "imagesaturation": (params, imageData) => this.applySaturation(imageData, params),
                    "saturation": (params, imageData) => this.applySaturation(imageData, params),
                    
                    // 色相节点
                    "imagehue": (params, imageData) => this.applyHue(imageData, params),
                    "hue": (params, imageData) => this.applyHue(imageData, params),
                    
                    // 曝光节点
                    "exposure": (params, imageData) => this.applyExposure(imageData, params),
                    "imageexposure": (params, imageData) => this.applyExposure(imageData, params),
                    "曝光": (params, imageData) => this.applyExposure(imageData, params),
                    
                    // 锐化节点
                    "sharpen": (params, imageData) => this.applySharpen(imageData, params),
                    "sharpenimage": (params, imageData) => this.applySharpen(imageData, params),
                    "imagesharpen": (params, imageData) => this.applySharpen(imageData, params),
                    "锐化": (params, imageData) => this.applySharpen(imageData, params),
                    
                    // 色温节点
                    "colortemperature": (params, imageData) => this.applyColorTemperature(imageData, params),
                    "temperature": (params, imageData) => this.applyColorTemperature(imageData, params),
                    "色温": (params, imageData) => this.applyColorTemperature(imageData, params),
                    
                    // 色调节点
                    "tint": (params, imageData) => this.applyTint(imageData, params),
                    "colortint": (params, imageData) => this.applyTint(imageData, params),
                    "色调": (params, imageData) => this.applyTint(imageData, params),
                    
                    // 高光阴影节点
                    "highlightsshadows": (params, imageData) => this.applyHighlightsShadows(imageData, params),
                    "highlights": (params, imageData) => this.applyHighlightsShadows(imageData, params),
                    "shadows": (params, imageData) => this.applyHighlightsShadows(imageData, params),
                    
                    // 颜色分级/调色节点
                    "colorgrading": (params, imageData) => this.applyColorGrading(imageData, params),
                    "grading": (params, imageData) => this.applyColorGrading(imageData, params),
                    "调色": (params, imageData) => this.applyColorGrading(imageData, params),
                };
                
                // 直接匹配
                if (processors[nodeTypeLower]) {
                    return processors[nodeTypeLower];
                }
                
                // 模糊匹配（检查节点类型是否包含关键词）
                for (const [key, processor] of Object.entries(processors)) {
                    if (nodeTypeLower.includes(key) || key.includes(nodeTypeLower)) {
                        return processor;
                    }
                }
                
                return null;
            };
            
            // 根据参数名称推断处理器（改进版，支持更多参数）
            nodeType.prototype.inferProcessorFromParams = function(params) {
                const paramNames = Object.keys(params).map(k => k.toLowerCase());
                
                // 构建通用处理管道
                const pipeline = [];
                
                // 曝光处理
                if (paramNames.some(name => name.includes("exposure"))) {
                    pipeline.push((img) => this.applyExposure(img, params));
                }
                
                // 锐化处理
                if (paramNames.some(name => name.includes("sharpen") || name.includes("sharpness"))) {
                    pipeline.push((img) => this.applySharpen(img, params));
                }
                
                // 色温处理
                if (paramNames.some(name => name.includes("temperature") || name.includes("temp") || name.includes("色温"))) {
                    pipeline.push((img) => this.applyColorTemperature(img, params));
                }
                
                // 色调处理
                if (paramNames.some(name => name.includes("tint") || name.includes("色调"))) {
                    pipeline.push((img) => this.applyTint(img, params));
                }
                
                // 高光/阴影处理
                if (paramNames.some(name => name.includes("highlight") || name.includes("shadow") || name.includes("高光") || name.includes("阴影"))) {
                    pipeline.push((img) => this.applyHighlightsShadows(img, params));
                }
                
                // 白色/黑色点处理
                if (paramNames.some(name => name.includes("white") || name.includes("black") || name.includes("whites") || name.includes("blacks"))) {
                    pipeline.push((img) => this.applyWhiteBlackPoint(img, params));
                }
                
                // 色调曲线或颜色分级
                if (paramNames.some(name => name.includes("curve") || name.includes("grading") || name.includes("调色"))) {
                    pipeline.push((img) => this.applyColorGrading(img, params));
                }
                
                // 亮度对比度处理
                if (paramNames.some(name => name.includes("brightness")) && paramNames.some(name => name.includes("contrast"))) {
                    if (paramNames.some(name => name.includes("saturation"))) {
                        pipeline.push((img) => this.applyColorAdjustment(img, params));
                    } else {
                        pipeline.push((img) => this.applyBrightnessContrast(img, params));
                    }
                } else {
                    // 单独的亮度或对比度
                    if (paramNames.some(name => name.includes("brightness"))) {
                        pipeline.push((img) => this.applyBrightness(img, params));
                    }
                    if (paramNames.some(name => name.includes("contrast"))) {
                        pipeline.push((img) => this.applyContrast(img, params));
                    }
                }
                
                // 饱和度处理
                if (paramNames.some(name => name.includes("saturation"))) {
                    pipeline.push((img) => this.applySaturation(img, params));
                }
                
                // 色相处理
                if (paramNames.some(name => name.includes("hue") && !name.includes("shadow"))) {
                    pipeline.push((img) => this.applyHue(img, params));
                }
                
                // 如果有处理管道，返回组合处理器
                if (pipeline.length > 0) {
                    return (params, imageData) => {
                        let result = imageData;
                        for (const processor of pipeline) {
                            result = processor(result);
                        }
                        return result;
                    };
                }
                
                return null;
            };
            
            // 前端处理
            nodeType.prototype.processInFrontend = function(params, processor) {
                if (!this.originalImageData || !this.canvas) {
                    return;
                }
                
                requestAnimationFrame(() => {
                    const ctx = this.canvas.getContext("2d");
                    const width = this.originalImageData[0].length;
                    const height = this.originalImageData.length;
                    
                    // 创建 ImageData
                    const imgData = new ImageData(width, height);
                    
                    // 填充原始数据
                    for (let y = 0; y < height; y++) {
                        for (let x = 0; x < width; x++) {
                            const idx = (y * width + x) * 4;
                            imgData.data[idx] = this.originalImageData[y][x][0];     // R
                            imgData.data[idx + 1] = this.originalImageData[y][x][1]; // G
                            imgData.data[idx + 2] = this.originalImageData[y][x][2]; // B
                            imgData.data[idx + 3] = 255;                             // A
                        }
                    }
                    
                    // 应用处理
                    const processedData = processor(params, imgData);
                    
                    // 更新画布
                    this.canvas.width = width;
                    this.canvas.height = height;
                    ctx.putImageData(processedData, 0, 0);
                });
            };
            
            // 后端处理（用于复杂操作或未知节点）
            // isDragging: true表示拖动中（已在拖动节流器中节流，直接执行），false或不传表示正常模式（使用正常节流）
            nodeType.prototype.processInBackend = async function(upstreamNode, params, isDragging = false) {
                if (!this.originalImageData || !this.canvas) {
                    console.warn('[ImagePreview] 无法处理：originalImageData或canvas不存在');
                    return;
                }
                
                // 检查参数是否变化（避免重复请求相同参数）
                const paramsStr = JSON.stringify(params);
                if (this.lastBackendParams === paramsStr) {
                    console.log('[ImagePreview] 参数未变化，跳过处理');
                    return; // 参数未变化，跳过
                }
                
                console.log(`[ImagePreview] 参数已变化，准备调用后端API处理 (拖动中: ${isDragging})`);
                
                // 如果是在拖动中调用（isDragging为true），说明已经在拖动节流器中节流过了，直接执行
                if (isDragging) {
                    try {
                        console.log('[ImagePreview] 拖动中：开始执行后端处理');
                        await this.executeBackendProcess(upstreamNode, params);
                        this.lastBackendParams = paramsStr;
                    } catch (error) {
                        console.error('[ImagePreview] 拖动时后端处理出错:', error);
                    }
                    return;
                }
                
                // 正常模式：使用节流处理（500ms节流时间）
                if (this.backendThrottle) {
                    clearTimeout(this.backendThrottle);
                }
                
                this.backendThrottle = setTimeout(async () => {
                    try {
                        // 再次检查是否在拖动（拖动可能已经结束）
                        if (this.isDragging) {
                            // 如果拖动已开始，取消这次调用（由拖动节流器处理）
                            return;
                        }
                        
                        console.log('[ImagePreview] 开始执行后端处理');
                        await this.executeBackendProcess(upstreamNode, params);
                        this.lastBackendParams = paramsStr;
                    } catch (error) {
                        console.error('[ImagePreview] 后端处理出错:', error);
                    }
                }, 300); // 正常模式使用300ms节流（优化：减少延迟）
            };
            
            // 执行后端处理
            nodeType.prototype.executeBackendProcess = async function(upstreamNode, params) {
                if (!this.originalImageData || !this.canvas) {
                    return;
                }
                
                try {
                    // 性能优化：使用缩略图发送到后端，减少数据传输和内存占用
                    const originalWidth = this.originalImageData[0].length;
                    const originalHeight = this.originalImageData.length;
                    
                    // 限制处理尺寸为1024px，减少后端处理时间
                    const MAX_PROCESS_SIZE = 1024;
                    let processWidth = originalWidth;
                    let processHeight = originalHeight;
                    let scaleX = 1.0;
                    let scaleY = 1.0;
                    
                    if (originalWidth > MAX_PROCESS_SIZE || originalHeight > MAX_PROCESS_SIZE) {
                        const ratio = Math.min(MAX_PROCESS_SIZE / originalWidth, MAX_PROCESS_SIZE / originalHeight);
                        processWidth = Math.floor(originalWidth * ratio);
                        processHeight = Math.floor(originalHeight * ratio);
                        scaleX = originalWidth / processWidth;
                        scaleY = originalHeight / processHeight;
                    }
                    
                    // 创建临时canvas（使用处理尺寸）
                    const tempCanvas = document.createElement('canvas');
                    tempCanvas.width = processWidth;
                    tempCanvas.height = processHeight;
                    const tempCtx = tempCanvas.getContext('2d');
                    
                    // 创建ImageData（使用处理尺寸）
                    const imgData = new ImageData(processWidth, processHeight);
                    const data = imgData.data;
                    
                    // 优化：采样处理（如果尺寸相同则直接复制，否则进行采样）
                    if (scaleX === 1.0 && scaleY === 1.0) {
                        // 无缩放：直接复制
                        let dataIdx = 0;
                        for (let y = 0; y < originalHeight; y++) {
                            const row = this.originalImageData[y];
                            for (let x = 0; x < originalWidth; x++) {
                                const pixel = row[x];
                                data[dataIdx] = pixel[0];
                                data[dataIdx + 1] = pixel[1];
                                data[dataIdx + 2] = pixel[2];
                                data[dataIdx + 3] = 255;
                                dataIdx += 4;
                            }
                        }
                    } else {
                        // 需要缩放：使用最近邻采样
                        let dataIdx = 0;
                        for (let y = 0; y < processHeight; y++) {
                            const srcY = Math.floor(y * scaleY);
                            const row = this.originalImageData[srcY];
                            for (let x = 0; x < processWidth; x++) {
                                const srcX = Math.floor(x * scaleX);
                                const pixel = row[srcX];
                                data[dataIdx] = pixel[0];
                                data[dataIdx + 1] = pixel[1];
                                data[dataIdx + 2] = pixel[2];
                                data[dataIdx + 3] = 255;
                                dataIdx += 4;
                            }
                        }
                    }
                    
                    tempCtx.putImageData(imgData, 0, 0);
                    
                    // 转换为base64（使用JPEG格式降低数据量，质量0.85）
                    const base64Image = tempCanvas.toDataURL('image/jpeg', 0.85);
                    
                    // 获取节点类型（尝试多种方式）
                    let nodeType = "";
                    if (upstreamNode.type) {
                        nodeType = upstreamNode.type;
                    } else if (upstreamNode.comfyClass) {
                        nodeType = upstreamNode.comfyClass;
                    } else if (upstreamNode.title) {
                        nodeType = upstreamNode.title;
                    } else if (upstreamNode.constructor && upstreamNode.constructor.name) {
                        nodeType = upstreamNode.constructor.name;
                    }
                    
                    console.log(`[ImagePreview] 准备调用后端API，节点类型: ${nodeType}，参数:`, params);
                    
                    // 调用后端API（传递处理尺寸和原始尺寸信息）
                    const response = await api.fetchApi('/image_preview/process', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            image_data: base64Image,
                            params: params,
                            node_type: nodeType,
                            width: processWidth,
                            height: processHeight,
                            original_width: originalWidth,
                            original_height: originalHeight,
                            scale_factor: scaleX // 使用scaleX作为缩放因子（假设scaleX == scaleY）
                        })
                    });
                    
                    console.log(`[ImagePreview] 后端API响应状态: ${response.status}`);
                    
                    if (!response.ok) {
                        const errorText = await response.text();
                        throw new Error(`后端处理失败: ${response.status}, ${errorText}`);
                    }
                    
                    const result = await response.json();
                    console.log('[ImagePreview] 后端API返回结果:', result.success ? '成功' : '失败', result.error || '');
                    
                    if (result.success && result.image_data) {
                        console.log('[ImagePreview] 加载处理后的图像');
                        // 加载处理后的图像
                        const img = new Image();
                        img.onload = () => {
                            const ctx = this.canvas.getContext("2d");
                            // 使用原尺寸
                            const displayWidth = result.width || width;
                            const displayHeight = result.height || height;
                            this.canvas.width = displayWidth;
                            this.canvas.height = displayHeight;
                            ctx.drawImage(img, 0, 0);
                            console.log('[ImagePreview] 预览已更新');
                        };
                        img.onerror = (e) => {
                            console.error('[ImagePreview] 图像加载失败:', e);
                            this.updatePreview();
                        };
                        img.src = result.image_data;
                    } else {
                        console.warn('[ImagePreview] 后端处理失败，使用原始图像:', result.error);
                        this.updatePreview();
                    }
                    
                } catch (error) {
                    console.error('[ImagePreview] 后端处理出错:', error);
                    // 出错时显示原始图像
                    this.updatePreview();
                }
            };
            
            // 图像处理函数：亮度对比度
            nodeType.prototype.applyBrightnessContrast = function(imageData, params) {
                const brightness = params.brightness !== undefined ? params.brightness : 1.0;
                const contrast = params.contrast !== undefined ? params.contrast : 1.0;
                
                const result = new Uint8ClampedArray(imageData.data);
                const len = result.length;
                const contrastFactor = contrast;
                const contrastOffset = 128 * (1 - contrast);
                
                for (let i = 0; i < len; i += 4) {
                    let r = Math.min(255, result[i] * brightness);
                    let g = Math.min(255, result[i + 1] * brightness);
                    let b = Math.min(255, result[i + 2] * brightness);
                    
                    r = r * contrastFactor + contrastOffset;
                    g = g * contrastFactor + contrastOffset;
                    b = b * contrastFactor + contrastOffset;
                    
                    result[i] = Math.min(255, Math.max(0, r));
                    result[i + 1] = Math.min(255, Math.max(0, g));
                    result[i + 2] = Math.min(255, Math.max(0, b));
                }
                
                return new ImageData(result, imageData.width, imageData.height);
            };
            
            // 图像处理函数：颜色调整（亮度、对比度、饱和度）
            nodeType.prototype.applyColorAdjustment = function(imageData, params) {
                const brightness = params.brightness !== undefined ? params.brightness : 1.0;
                const contrast = params.contrast !== undefined ? params.contrast : 1.0;
                const saturation = params.saturation !== undefined ? params.saturation : 1.0;
                
                const result = new Uint8ClampedArray(imageData.data);
                const len = result.length;
                const contrastFactor = contrast;
                const contrastOffset = 128 * (1 - contrast);
                
                for (let i = 0; i < len; i += 4) {
                    // 亮度和对比度
                    let r = Math.min(255, result[i] * brightness);
                    let g = Math.min(255, result[i + 1] * brightness);
                    let b = Math.min(255, result[i + 2] * brightness);
                    
                    r = r * contrastFactor + contrastOffset;
                    g = g * contrastFactor + contrastOffset;
                    b = b * contrastFactor + contrastOffset;
                    
                    // 饱和度
                    if (saturation !== 1.0) {
                        const avg = r * 0.299 + g * 0.587 + b * 0.114;
                        r = avg + (r - avg) * saturation;
                        g = avg + (g - avg) * saturation;
                        b = avg + (b - avg) * saturation;
                    }
                    
                    result[i] = Math.min(255, Math.max(0, r));
                    result[i + 1] = Math.min(255, Math.max(0, g));
                    result[i + 2] = Math.min(255, Math.max(0, b));
                }
                
                return new ImageData(result, imageData.width, imageData.height);
            };
            
            // 图像处理函数：饱和度
            nodeType.prototype.applySaturation = function(imageData, params) {
                const saturation = params.saturation !== undefined ? params.saturation : 1.0;
                
                if (saturation === 1.0) {
                    return imageData;
                }
                
                const result = new Uint8ClampedArray(imageData.data);
                const len = result.length;
                
                for (let i = 0; i < len; i += 4) {
                    const r = result[i];
                    const g = result[i + 1];
                    const b = result[i + 2];
                    
                    const avg = r * 0.299 + g * 0.587 + b * 0.114;
                    
                    result[i] = Math.min(255, Math.max(0, avg + (r - avg) * saturation));
                    result[i + 1] = Math.min(255, Math.max(0, avg + (g - avg) * saturation));
                    result[i + 2] = Math.min(255, Math.max(0, avg + (b - avg) * saturation));
                }
                
                return new ImageData(result, imageData.width, imageData.height);
            };
            
            // 图像处理函数：色相
            nodeType.prototype.applyHue = function(imageData, params) {
                const hue = params.hue !== undefined ? params.hue : 
                           (params.hue_shift !== undefined ? params.hue_shift : 0.0);
                
                if (hue === 0.0) {
                    return imageData;
                }
                
                const result = new Uint8ClampedArray(imageData.data);
                const len = result.length;
                const hueRad = (hue * Math.PI) / 180;
                const cosHue = Math.cos(hueRad);
                const sinHue = Math.sin(hueRad);
                
                // 色相旋转矩阵
                const matrix = [
                    cosHue + (1 - cosHue) / 3, (1 - cosHue) / 3 - Math.sqrt(1/3) * sinHue, (1 - cosHue) / 3 + Math.sqrt(1/3) * sinHue,
                    (1 - cosHue) / 3 + Math.sqrt(1/3) * sinHue, cosHue + (1 - cosHue) / 3, (1 - cosHue) / 3 - Math.sqrt(1/3) * sinHue,
                    (1 - cosHue) / 3 - Math.sqrt(1/3) * sinHue, (1 - cosHue) / 3 + Math.sqrt(1/3) * sinHue, cosHue + (1 - cosHue) / 3
                ];
                
                for (let i = 0; i < len; i += 4) {
                    const r = result[i];
                    const g = result[i + 1];
                    const b = result[i + 2];
                    
                    result[i] = Math.min(255, Math.max(0, r * matrix[0] + g * matrix[1] + b * matrix[2]));
                    result[i + 1] = Math.min(255, Math.max(0, r * matrix[3] + g * matrix[4] + b * matrix[5]));
                    result[i + 2] = Math.min(255, Math.max(0, r * matrix[6] + g * matrix[7] + b * matrix[8]));
                }
                
                return new ImageData(result, imageData.width, imageData.height);
            };
            
            // 图像处理函数：曝光
            nodeType.prototype.applyExposure = function(imageData, params) {
                const exposure = params.exposure !== undefined ? params.exposure : 0.0;
                
                if (exposure === 0.0) {
                    return imageData;
                }
                
                // 曝光值转换为倍数 (exposure通常范围是-2到+2，转换为0.25到4.0)
                const exposureFactor = Math.pow(2, exposure);
                
                const result = new Uint8ClampedArray(imageData.data);
                const len = result.length;
                
                for (let i = 0; i < len; i += 4) {
                    result[i] = Math.min(255, Math.max(0, result[i] * exposureFactor));
                    result[i + 1] = Math.min(255, Math.max(0, result[i + 1] * exposureFactor));
                    result[i + 2] = Math.min(255, Math.max(0, result[i + 2] * exposureFactor));
                }
                
                return new ImageData(result, imageData.width, imageData.height);
            };
            
            // 图像处理函数：锐化
            nodeType.prototype.applySharpen = function(imageData, params) {
                const sharpen = params.sharpen !== undefined ? params.sharpen : 
                              (params.sharpness !== undefined ? params.sharpness : 0.0);
                
                if (sharpen === 0.0) {
                    return imageData;
                }
                
                // 锐化内核（拉普拉斯算子）
                const kernel = [
                    0, -1, 0,
                    -1, 5, -1,
                    0, -1, 0
                ];
                
                // 调整锐化强度
                const strength = Math.abs(sharpen);
                const normalizedKernel = kernel.map(v => v * strength);
                normalizedKernel[4] = 1 + (normalizedKernel[4] - 1) * strength;
                
                return this.applyConvolution(imageData, normalizedKernel, 3);
            };
            
            // 图像处理函数：色温
            nodeType.prototype.applyColorTemperature = function(imageData, params) {
                const temp = params.temperature !== undefined ? params.temperature : 
                            (params.temp !== undefined ? params.temp : 
                            (params.色温 !== undefined ? params.色温 : 0.0));
                
                if (temp === 0.0) {
                    return imageData;
                }
                
                // 色温范围通常是-100到+100，转换为RGB调整
                // 暖色(正数)增加红色减少蓝色，冷色(负数)增加蓝色减少红色
                const tempFactor = temp / 100.0; // 归一化到-1到1
                const warmFactor = Math.max(0, tempFactor); // 暖色因子
                const coolFactor = Math.max(0, -tempFactor); // 冷色因子
                
                const result = new Uint8ClampedArray(imageData.data);
                const len = result.length;
                
                for (let i = 0; i < len; i += 4) {
                    let r = result[i];
                    let g = result[i + 1];
                    let b = result[i + 2];
                    
                    // 暖色调整
                    r += warmFactor * 20;
                    b -= warmFactor * 20;
                    
                    // 冷色调整
                    r -= coolFactor * 20;
                    b += coolFactor * 20;
                    
                    result[i] = Math.min(255, Math.max(0, r));
                    result[i + 1] = Math.min(255, Math.max(0, g));
                    result[i + 2] = Math.min(255, Math.max(0, b));
                }
                
                return new ImageData(result, imageData.width, imageData.height);
            };
            
            // 图像处理函数：色调（Tint）
            nodeType.prototype.applyTint = function(imageData, params) {
                const tint = params.tint !== undefined ? params.tint : 
                            (params.色调 !== undefined ? params.色调 : 0.0);
                
                if (tint === 0.0) {
                    return imageData;
                }
                
                // 色调调整：绿色/品红色
                const tintFactor = tint / 100.0;
                
                const result = new Uint8ClampedArray(imageData.data);
                const len = result.length;
                
                for (let i = 0; i < len; i += 4) {
                    let r = result[i];
                    let g = result[i + 1];
                    let b = result[i + 2];
                    
                    // 正数增加绿色，负数增加品红色
                    if (tintFactor > 0) {
                        g += tintFactor * 15;
                    } else {
                        r += Math.abs(tintFactor) * 15;
                        b += Math.abs(tintFactor) * 15;
                    }
                    
                    result[i] = Math.min(255, Math.max(0, r));
                    result[i + 1] = Math.min(255, Math.max(0, g));
                    result[i + 2] = Math.min(255, Math.max(0, b));
                }
                
                return new ImageData(result, imageData.width, imageData.height);
            };
            
            // 图像处理函数：高光/阴影
            nodeType.prototype.applyHighlightsShadows = function(imageData, params) {
                const highlights = params.highlights !== undefined ? params.highlights : 
                                 (params.highlight !== undefined ? params.highlight : 
                                 (params.高光 !== undefined ? params.高光 : 0.0));
                const shadows = params.shadows !== undefined ? params.shadows : 
                              (params.shadow !== undefined ? params.shadow : 
                              (params.阴影 !== undefined ? params.阴影 : 0.0));
                
                if (highlights === 0.0 && shadows === 0.0) {
                    return imageData;
                }
                
                const result = new Uint8ClampedArray(imageData.data);
                const len = result.length;
                
                for (let i = 0; i < len; i += 4) {
                    const r = result[i];
                    const g = result[i + 1];
                    const b = result[i + 2];
                    
                    // 计算亮度
                    const brightness = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
                    
                    let factor = 1.0;
                    
                    // 高光调整（影响亮部）
                    if (brightness > 0.5 && highlights !== 0) {
                        const highlightAmount = (brightness - 0.5) * 2; // 0到1
                        factor += highlights * highlightAmount * 0.01;
                    }
                    
                    // 阴影调整（影响暗部）
                    if (brightness < 0.5 && shadows !== 0) {
                        const shadowAmount = (0.5 - brightness) * 2; // 0到1
                        factor += shadows * shadowAmount * 0.01;
                    }
                    
                    result[i] = Math.min(255, Math.max(0, r * factor));
                    result[i + 1] = Math.min(255, Math.max(0, g * factor));
                    result[i + 2] = Math.min(255, Math.max(0, b * factor));
                }
                
                return new ImageData(result, imageData.width, imageData.height);
            };
            
            // 图像处理函数：白色/黑色点
            nodeType.prototype.applyWhiteBlackPoint = function(imageData, params) {
                const white = params.white !== undefined ? params.white : 
                             (params.whites !== undefined ? params.whites : 0.0);
                const black = params.black !== undefined ? params.black : 
                             (params.blacks !== undefined ? params.blacks : 0.0);
                
                if (white === 0.0 && black === 0.0) {
                    return imageData;
                }
                
                const result = new Uint8ClampedArray(imageData.data);
                const len = result.length;
                
                // 白点调整：提高最亮部分的亮度
                const whiteFactor = 1.0 + white * 0.01;
                // 黑点调整：降低最暗部分的亮度
                const blackFactor = black * 0.01;
                
                for (let i = 0; i < len; i += 4) {
                    const r = result[i];
                    const g = result[i + 1];
                    const b = result[i + 2];
                    
                    // 计算归一化亮度
                    const brightness = (r + g + b) / 3 / 255;
                    
                    let newR = r;
                    let newG = g;
                    let newB = b;
                    
                    // 白点调整
                    if (white > 0 && brightness > 0.8) {
                        const amount = (brightness - 0.8) / 0.2; // 0到1
                        newR = r + (255 - r) * amount * white * 0.01;
                        newG = g + (255 - g) * amount * white * 0.01;
                        newB = b + (255 - b) * amount * white * 0.01;
                    }
                    
                    // 黑点调整
                    if (black < 0 && brightness < 0.2) {
                        const amount = (0.2 - brightness) / 0.2; // 0到1
                        newR = r * (1 + amount * black * 0.01);
                        newG = g * (1 + amount * black * 0.01);
                        newB = b * (1 + amount * black * 0.01);
                    }
                    
                    result[i] = Math.min(255, Math.max(0, newR));
                    result[i + 1] = Math.min(255, Math.max(0, newG));
                    result[i + 2] = Math.min(255, Math.max(0, newB));
                }
                
                return new ImageData(result, imageData.width, imageData.height);
            };
            
            // 图像处理函数：颜色分级/调色
            nodeType.prototype.applyColorGrading = function(imageData, params) {
                // 简化的颜色分级实现
                // 支持常见的调色参数
                const result = new Uint8ClampedArray(imageData.data);
                const len = result.length;
                
                // 支持RGB通道单独调整
                const redAdjust = params.red !== undefined ? params.red : 0.0;
                const greenAdjust = params.green !== undefined ? params.green : 0.0;
                const blueAdjust = params.blue !== undefined ? params.blue : 0.0;
                
                if (redAdjust === 0.0 && greenAdjust === 0.0 && blueAdjust === 0.0) {
                    return imageData;
                }
                
                for (let i = 0; i < len; i += 4) {
                    result[i] = Math.min(255, Math.max(0, result[i] + redAdjust));
                    result[i + 1] = Math.min(255, Math.max(0, result[i + 1] + greenAdjust));
                    result[i + 2] = Math.min(255, Math.max(0, result[i + 2] + blueAdjust));
                }
                
                return new ImageData(result, imageData.width, imageData.height);
            };
            
            // 图像处理函数：单独亮度
            nodeType.prototype.applyBrightness = function(imageData, params) {
                const brightness = params.brightness !== undefined ? params.brightness : 1.0;
                
                if (brightness === 1.0) {
                    return imageData;
                }
                
                const result = new Uint8ClampedArray(imageData.data);
                const len = result.length;
                
                for (let i = 0; i < len; i += 4) {
                    result[i] = Math.min(255, Math.max(0, result[i] * brightness));
                    result[i + 1] = Math.min(255, Math.max(0, result[i + 1] * brightness));
                    result[i + 2] = Math.min(255, Math.max(0, result[i + 2] * brightness));
                }
                
                return new ImageData(result, imageData.width, imageData.height);
            };
            
            // 图像处理函数：单独对比度
            nodeType.prototype.applyContrast = function(imageData, params) {
                const contrast = params.contrast !== undefined ? params.contrast : 1.0;
                
                if (contrast === 1.0) {
                    return imageData;
                }
                
                const result = new Uint8ClampedArray(imageData.data);
                const len = result.length;
                const contrastFactor = contrast;
                const contrastOffset = 128 * (1 - contrast);
                
                for (let i = 0; i < len; i += 4) {
                    result[i] = Math.min(255, Math.max(0, result[i] * contrastFactor + contrastOffset));
                    result[i + 1] = Math.min(255, Math.max(0, result[i + 1] * contrastFactor + contrastOffset));
                    result[i + 2] = Math.min(255, Math.max(0, result[i + 2] * contrastFactor + contrastOffset));
                }
                
                return new ImageData(result, imageData.width, imageData.height);
            };
            
            // 创建通用处理器（对于任何参数都应用简单变换）
            nodeType.prototype.createGenericProcessor = function(params) {
                // 对所有数值参数应用简单的亮度/对比度调整
                const hasParams = Object.values(params).some(v => typeof v === 'number' && v !== 0 && v !== 1);
                
                if (!hasParams) {
                    return null;
                }
                
                return (params, imageData) => {
                    const result = new Uint8ClampedArray(imageData.data);
                    const len = result.length;
                    
                    // 计算所有参数的加权平均作为调整因子
                    let factor = 1.0;
                    const paramValues = Object.values(params).filter(v => typeof v === 'number');
                    if (paramValues.length > 0) {
                        const sum = paramValues.reduce((a, b) => a + Math.abs(b), 0);
                        const avg = sum / paramValues.length;
                        factor = 1.0 + (avg / 100.0) * 0.1; // 转换为调整因子
                    }
                    
                    // 应用简单的亮度调整
                    for (let i = 0; i < len; i += 4) {
                        result[i] = Math.min(255, Math.max(0, result[i] * factor));
                        result[i + 1] = Math.min(255, Math.max(0, result[i + 1] * factor));
                        result[i + 2] = Math.min(255, Math.max(0, result[i + 2] * factor));
                    }
                    
                    return new ImageData(result, imageData.width, imageData.height);
                };
            };
            
            // 通用卷积函数（用于锐化等效果）- 性能优化版本
            nodeType.prototype.applyConvolution = function(imageData, kernel, kernelSize) {
                const width = imageData.width;
                const height = imageData.height;
                const data = imageData.data;
                const result = new Uint8ClampedArray(data.length);
                
                const halfKernel = Math.floor(kernelSize / 2);
                
                // 性能优化：对于3x3内核，使用展开循环
                if (kernelSize === 3) {
                    const k = kernel;
                    for (let y = 0; y < height; y++) {
                        for (let x = 0; x < width; x++) {
                            let r = 0, g = 0, b = 0;
                            
                            // 展开3x3卷积循环
                            const offsets = [
                                [-1, -1], [0, -1], [1, -1],
                                [-1, 0], [0, 0], [1, 0],
                                [-1, 1], [0, 1], [1, 1]
                            ];
                            
                            for (let i = 0; i < 9; i++) {
                                const px = x + offsets[i][0];
                                const py = y + offsets[i][1];
                                
                                if (px >= 0 && px < width && py >= 0 && py < height) {
                                    const idx = (py * width + px) * 4;
                                    const kernelValue = k[i];
                                    
                                    r += data[idx] * kernelValue;
                                    g += data[idx + 1] * kernelValue;
                                    b += data[idx + 2] * kernelValue;
                                }
                            }
                            
                            const idx = (y * width + x) * 4;
                            result[idx] = Math.min(255, Math.max(0, r));
                            result[idx + 1] = Math.min(255, Math.max(0, g));
                            result[idx + 2] = Math.min(255, Math.max(0, b));
                            result[idx + 3] = data[idx + 3];
                        }
                    }
                } else {
                    // 通用版本（用于其他内核大小）
                    for (let y = 0; y < height; y++) {
                        for (let x = 0; x < width; x++) {
                            let r = 0, g = 0, b = 0;
                            
                            for (let ky = 0; ky < kernelSize; ky++) {
                                for (let kx = 0; kx < kernelSize; kx++) {
                                    const px = x + kx - halfKernel;
                                    const py = y + ky - halfKernel;
                                    
                                    if (px >= 0 && px < width && py >= 0 && py < height) {
                                        const idx = (py * width + px) * 4;
                                        const kernelValue = kernel[ky * kernelSize + kx];
                                        
                                        r += data[idx] * kernelValue;
                                        g += data[idx + 1] * kernelValue;
                                        b += data[idx + 2] * kernelValue;
                                    }
                                }
                            }
                            
                            const idx = (y * width + x) * 4;
                            result[idx] = Math.min(255, Math.max(0, r));
                            result[idx + 1] = Math.min(255, Math.max(0, g));
                            result[idx + 2] = Math.min(255, Math.max(0, b));
                            result[idx + 3] = data[idx + 3];
                        }
                    }
                }
                
                return new ImageData(result, width, height);
            };

            // 添加WebSocket设置方法
            nodeType.prototype.setupWebSocket = function() {
                console.log(`[ImagePreview] 节点 ${this.id} 设置WebSocket监听`);
                api.addEventListener("image_preview_update", async (event) => {
                    const data = event.detail;
                    
                    if (data && data.node_id && data.node_id === this.id.toString()) {
                        console.log(`[ImagePreview] 节点 ${this.id} 接收到更新数据`);
                        if (data.image_data) {
                            console.log("[ImagePreview] 接收到base64数据:", {
                                nodeId: this.id,
                                dataLength: data.image_data.length,
                                isBase64: data.image_data.startsWith("data:image"),
                                timestamp: new Date().toISOString()
                            });
                            
                            this.loadImageFromBase64(data.image_data);
                        } else {
                            console.warn("[ImagePreview] 接收到空的图像数据");
                        }
                    }
                });
            };

            // 添加从base64加载图像的方法
            nodeType.prototype.loadImageFromBase64 = function(base64Data) {
                console.log(`[ImagePreview] 节点 ${this.id} 开始加载base64图像数据`);
                const img = new Image();
                
                img.onload = () => {
                    console.log(`[ImagePreview] 节点 ${this.id} 图像加载完成: ${img.width}x${img.height}`);
                    
                    // 创建一个临时画布来获取像素数据
                    const tempCanvas = document.createElement('canvas');
                    tempCanvas.width = img.width;
                    tempCanvas.height = img.height;
                    const tempCtx = tempCanvas.getContext('2d');
                    
                    // 在临时画布上绘制图像
                    tempCtx.drawImage(img, 0, 0);
                    
                    // 获取像素数据
                    const imageData = tempCtx.getImageData(0, 0, img.width, img.height);
                    
                    // 性能优化：使用预分配数组，减少内存分配次数
                    const pixelArray = new Array(img.height);
                    const data = imageData.data;
                    const width = img.width;
                    const height = img.height;
                    
                    // 优化：减少push操作，直接索引赋值
                    for (let y = 0; y < height; y++) {
                        const row = new Array(width);
                        const rowOffset = y * width * 4;
                        for (let x = 0; x < width; x++) {
                            const idx = rowOffset + x * 4;
                            row[x] = [
                                data[idx],     // R
                                data[idx + 1], // G
                                data[idx + 2]  // B
                            ];
                        }
                        pixelArray[y] = row;
                    }
                    
                    // 存储像素数据并更新预览
                    this.originalImageData = pixelArray;
                    this.updatePreview();
                    
                    // 图像加载后，重新检查上游节点（确保监听已设置）
                    setTimeout(() => {
                        this.checkUpstreamNodes();
                    }, 200);
                };
                
                // 设置图像源
                img.src = base64Data;
            };

            // 添加节点时的处理
            const onAdded = nodeType.prototype.onAdded;
            nodeType.prototype.onAdded = function() {
                const result = onAdded?.apply(this, arguments);
                
                if (!this.previewElement && this.id !== undefined && this.id !== -1) {
                    // 优化：使用cssText批量设置样式，减少DOM重排次数
                    const previewContainer = document.createElement("div");
                    previewContainer.style.cssText = "position:relative;width:100%;min-height:200px;background-color:#333;border-radius:8px;overflow:hidden;display:flex;align-items:center;justify-content:center";
                    
                    // 优化：使用cssText批量设置canvas样式
                    const canvas = document.createElement("canvas");
                    canvas.style.cssText = "max-width:100%;max-height:100%;object-fit:contain";
                    
                    previewContainer.appendChild(canvas);
                    this.canvas = canvas;
                    this.previewElement = previewContainer;
                    
                    // 优化：延迟事件监听器注册，避免阻塞主线程
                    // 使用requestAnimationFrame分批执行，确保UI响应流畅
                    requestAnimationFrame(() => {
                        // 修复滚轮缩放失效问题：确保滚轮事件能冒泡到画布层
                        // 在选择工具模式下，ComfyUI的节点选择监听器可能拦截滚轮事件
                        // 需要在捕获阶段尽早处理，并转发到画布容器
                        
                        // 优化：缓存画布元素，避免每次事件都查询
                        let cachedGraphCanvas = null;
                        let cachedTargets = null;
                        
                        const getTargets = () => {
                            if (cachedTargets) {
                                return cachedTargets;
                            }
                            
                            if (!cachedGraphCanvas) {
                                cachedGraphCanvas = app.graph?.canvas;
                            }
                            
                            if (!cachedGraphCanvas) {
                                return [];
                            }
                            
                            // 优化：减少DOM查询，只查询必要的元素
                            const targets = [
                                cachedGraphCanvas,
                                cachedGraphCanvas.parentElement
                            ].filter(Boolean);
                            
                            // 延迟查询其他元素，只在需要时查询
                            if (targets.length === 0) {
                                const lgraphCanvas = document.querySelector('.lgraphcanvas');
                                if (lgraphCanvas) {
                                    targets.push(lgraphCanvas);
                                }
                                if (app.canvas) {
                                    targets.push(app.canvas);
                                }
                            }
                            
                            cachedTargets = targets;
                            return targets;
                        };
                        
                        const handleWheel = (e) => {
                            const targets = getTargets();
                            if (targets.length === 0) {
                                return;
                            }
                            
                            // 优化：只转发到第一个可用目标，减少事件创建开销
                            const target = targets[0];
                            if (target && target !== e.target) {
                                try {
                                    const wheelEvent = new WheelEvent('wheel', {
                                        deltaX: e.deltaX,
                                        deltaY: e.deltaY,
                                        deltaZ: e.deltaZ,
                                        deltaMode: e.deltaMode,
                                        clientX: e.clientX,
                                        clientY: e.clientY,
                                        screenX: e.screenX,
                                        screenY: e.screenY,
                                        bubbles: true,
                                        cancelable: true,
                                        view: window
                                    });
                                    target.dispatchEvent(wheelEvent);
                                } catch (err) {
                                    // 忽略错误
                                }
                            }
                        };
                        
                        // 保存事件处理器引用，以便在节点移除时清理
                        this.wheelEventHandler = handleWheel;
                        this.wheelEventHandlerBubble = handleWheel;
                        
                        // 优化：减少事件监听器数量，只保留必要的
                        // 在捕获阶段监听，确保能在ComfyUI的选择工具监听器之前处理
                        previewContainer.addEventListener('wheel', handleWheel, { passive: false, capture: true });
                        canvas.addEventListener('wheel', handleWheel, { passive: false, capture: true });
                        
                        // 保留冒泡阶段作为备用
                        previewContainer.addEventListener('wheel', handleWheel, { passive: false, capture: false });
                        canvas.addEventListener('wheel', handleWheel, { passive: false, capture: false });
                    });
                    
                    // 添加DOM部件
                    this.widgets ||= [];
                    this.widgets_up = true;
                    
                    requestAnimationFrame(() => {
                        if (this.widgets) {
                            this.previewWidget = this.addDOMWidget("preview", "preview", previewContainer);
                            this.setDirtyCanvas(true, true);
                        }
                    });
                }
                
                return result;
            };

            // 更新预览方法
            nodeType.prototype.updatePreview = function(onlyPreview = false) {
                if (!this.originalImageData || !this.canvas) {
                    return;
                }
                
                requestAnimationFrame(() => {
                    const ctx = this.canvas.getContext("2d");
                    const originalWidth = this.originalImageData[0].length;
                    const originalHeight = this.originalImageData.length;
                    
                    if (!onlyPreview) {
                        console.log(`[ImagePreview] 节点 ${this.id} 更新预览 (${originalWidth}x${originalHeight})`);
                    }
                    
                    // 性能优化：限制canvas显示尺寸，减少内存占用和putImageData操作时间
                    const MAX_DISPLAY_SIZE = 1024;
                    let displayWidth = originalWidth;
                    let displayHeight = originalHeight;
                    let scaleX = 1.0;
                    let scaleY = 1.0;
                    
                    if (originalWidth > MAX_DISPLAY_SIZE || originalHeight > MAX_DISPLAY_SIZE) {
                        const ratio = Math.min(MAX_DISPLAY_SIZE / originalWidth, MAX_DISPLAY_SIZE / originalHeight);
                        displayWidth = Math.floor(originalWidth * ratio);
                        displayHeight = Math.floor(originalHeight * ratio);
                        scaleX = originalWidth / displayWidth;
                        scaleY = originalHeight / displayHeight;
                    }
                    
                    // 创建ImageData（使用显示尺寸，减少内存占用）
                    const imgData = new ImageData(displayWidth, displayHeight);
                    const data = imgData.data;
                    
                    // 优化：使用更高效的循环方式填充数据（如果需要缩放，进行采样）
                    if (scaleX === 1.0 && scaleY === 1.0) {
                        // 无缩放：直接复制
                        let dataIdx = 0;
                        for (let y = 0; y < originalHeight; y++) {
                            const row = this.originalImageData[y];
                            for (let x = 0; x < originalWidth; x++) {
                                const pixel = row[x];
                                data[dataIdx] = pixel[0];     // R
                                data[dataIdx + 1] = pixel[1]; // G
                                data[dataIdx + 2] = pixel[2]; // B
                                data[dataIdx + 3] = 255;      // A
                                dataIdx += 4;
                            }
                        }
                    } else {
                        // 需要缩放：使用最近邻采样（性能优化）
                        let dataIdx = 0;
                        for (let y = 0; y < displayHeight; y++) {
                            const srcY = Math.floor(y * scaleY);
                            const row = this.originalImageData[srcY];
                            for (let x = 0; x < displayWidth; x++) {
                                const srcX = Math.floor(x * scaleX);
                                const pixel = row[srcX];
                                data[dataIdx] = pixel[0];     // R
                                data[dataIdx + 1] = pixel[1]; // G
                                data[dataIdx + 2] = pixel[2]; // B
                                data[dataIdx + 3] = 255;      // A
                                dataIdx += 4;
                            }
                        }
                    }
                    
                    // 调整画布大小并显示（使用显示尺寸，大大减少内存占用）
                    this.canvas.width = displayWidth;
                    this.canvas.height = displayHeight;
                    ctx.putImageData(imgData, 0, 0);
                    
                    // 发送原始数据回后端（用于后续处理）
                    if (!onlyPreview) {
                        // 发送时使用原始尺寸的ImageData
                        const originalImgData = new ImageData(originalWidth, originalHeight);
                        const originalData = originalImgData.data;
                        let dataIdx = 0;
                        for (let y = 0; y < originalHeight; y++) {
                            const row = this.originalImageData[y];
                            for (let x = 0; x < originalWidth; x++) {
                                const pixel = row[x];
                                originalData[dataIdx] = pixel[0];
                                originalData[dataIdx + 1] = pixel[1];
                                originalData[dataIdx + 2] = pixel[2];
                                originalData[dataIdx + 3] = 255;
                                dataIdx += 4;
                            }
                        }
                        this.sendImageData(originalImgData);
                    }
                });
            };

            // 添加发送图像数据的方法
            nodeType.prototype.sendImageData = async function(imageData) {
                try {
                    const endpoint = '/image_preview/apply';
                    const nodeId = String(this.id);
                    
                    api.fetchApi(endpoint, {
                        method: 'POST',
                        body: JSON.stringify({
                            node_id: nodeId,
                            adjusted_data: Array.from(imageData.data),
                            width: imageData.width,
                            height: imageData.height
                        })
                    }).then(response => {
                        if (!response.ok) {
                            throw new Error(`服务器返回错误: ${response.status}`);
                        }
                        return response.json();
                    }).catch(error => {
                        console.error('数据发送失败:', error);
                    });
                } catch (error) {
                    console.error('发送数据时出错:', error);
                }
            };

            // 节点移除时的处理
            const onRemoved = nodeType.prototype.onRemoved;
            nodeType.prototype.onRemoved = function() {
                // 优化：标记为已移除，避免缓存中的节点继续被使用
                this.removed = true;
                
                const result = onRemoved?.apply(this, arguments);
                
                // 清除上游节点监听器（会从缓存中移除）
                if (this.clearUpstreamListeners) {
                    this.clearUpstreamListeners();
                }
                
                // 清除节流定时器
                if (this.updateThrottle) {
                    clearTimeout(this.updateThrottle);
                    this.updateThrottle = null;
                }
                
                // 清除后端节流定时器
                if (this.backendThrottle) {
                    clearTimeout(this.backendThrottle);
                    this.backendThrottle = null;
                }
                
                // 清除拖动时的后端节流定时器
                if (this.dragBackendThrottle) {
                    clearTimeout(this.dragBackendThrottle);
                    this.dragBackendThrottle = null;
                }
                
                // 清理滚轮事件监听器（包括捕获和冒泡阶段）
                if (this.wheelEventHandler && this.previewElement) {
                    const previewContainer = this.previewElement;
                    const canvas = this.canvas;
                    if (previewContainer) {
                        // 移除捕获阶段的监听器
                        previewContainer.removeEventListener('wheel', this.wheelEventHandler, { capture: true });
                        // 移除冒泡阶段的监听器
                        previewContainer.removeEventListener('wheel', this.wheelEventHandler, { capture: false });
                    }
                    if (canvas) {
                        // 移除捕获阶段的监听器
                        canvas.removeEventListener('wheel', this.wheelEventHandler, { capture: true });
                        // 移除冒泡阶段的监听器
                        canvas.removeEventListener('wheel', this.wheelEventHandler, { capture: false });
                    }
                    this.wheelEventHandler = null;
                    this.wheelEventHandlerBubble = null;
                }
                
                if (this && this.canvas) {
                    const ctx = this.canvas.getContext("2d");
                    if (ctx) {
                        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
                    }
                    this.canvas = null;
                }
                if (this) {
                    this.previewElement = null;
                }
                
                return result;
            };
        }
    }
});

