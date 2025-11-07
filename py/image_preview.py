import torch
import numpy as np
from PIL import Image
import io
import base64
from aiohttp import web
from server import PromptServer


class ImagePreviewNode:
    """图像实时预览节点"""
    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            }
        }

    RETURN_TYPES = ()
    FUNCTION = "preview"
    CATEGORY = "🔵BB ImagePreview"
    OUTPUT_NODE = True

    def preview(self, image, unique_id):
        node_id = None
        try:
            node_id = unique_id
            
            # 将图像转换为base64格式发送到前端（优化：创建缩略图减少内存和传输开销）
            preview_image = (torch.clamp(image.clone(), 0, 1) * 255).cpu().numpy().astype(np.uint8)[0]
            pil_image = Image.fromarray(preview_image)
            
            # 性能优化：限制预览图像最大尺寸为1024px，减少内存占用和传输时间
            MAX_PREVIEW_SIZE = 1024
            if pil_image.width > MAX_PREVIEW_SIZE or pil_image.height > MAX_PREVIEW_SIZE:
                # 计算缩放比例，保持宽高比
                ratio = min(MAX_PREVIEW_SIZE / pil_image.width, MAX_PREVIEW_SIZE / pil_image.height)
                new_width = int(pil_image.width * ratio)
                new_height = int(pil_image.height * ratio)
                pil_image = pil_image.resize((new_width, new_height), Image.Resampling.LANCZOS)
            
            buffer = io.BytesIO()
            # 使用JPEG格式和质量压缩（优化：比PNG更快更小）
            if pil_image.mode == 'RGBA':
                # RGBA需要转换为RGB
                rgb_image = Image.new('RGB', pil_image.size, (255, 255, 255))
                rgb_image.paste(pil_image, mask=pil_image.split()[3])
                rgb_image.save(buffer, format="JPEG", quality=85, optimize=True)
            else:
                pil_image.save(buffer, format="JPEG", quality=85, optimize=True)
            base64_image = base64.b64encode(buffer.getvalue()).decode('utf-8')
            
            try:
                # 通过WebSocket发送图像数据到前端
                PromptServer.instance.send_sync("image_preview_update", {
                    "node_id": node_id,
                    "image_data": f"data:image/jpeg;base64,{base64_image}"
                })
            except Exception as e:
                pass  # 发送失败不影响节点执行
            
        except Exception as e:
            pass  # 处理失败不影响节点执行
        
        # 无输出，返回空元组
        return ()

@PromptServer.instance.routes.post("/image_preview/apply")
async def apply_image_preview(request):
    """接收前端发送的调整后的图像数据（保留接口以兼容前端，但不再处理输出）"""
    try:
        # 由于已移除输出口，此接口仅用于兼容前端调用
        return web.json_response({"success": True})
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)})

@PromptServer.instance.routes.post("/image_preview/process")
async def process_image_preview(request):
    """通用的图像处理API，支持任何节点的参数和类型"""
    try:
        data = await request.json()
        image_data = data.get("image_data")  # base64 图像数据
        params = data.get("params", {})  # 节点参数
        node_type = data.get("node_type", "")  # 节点类型
        
        try:
            # 解析图像数据
            if isinstance(image_data, str):
                if image_data.startswith("data:image"):
                    image_data = image_data.split(",")[1]
                image_bytes = base64.b64decode(image_data)
                pil_image = Image.open(io.BytesIO(image_bytes))
                img_array = np.array(pil_image)
            else:
                raise ValueError("不支持的图像数据格式")
            
            # 转换为torch tensor格式 (ComfyUI格式)
            if len(img_array.shape) == 3:
                # RGB图像
                tensor_image = torch.from_numpy(img_array.astype(np.float32) / 255.0).unsqueeze(0)
            else:
                raise ValueError("不支持的图像格式")
            
            # 尝试使用ComfyUI的节点类处理
            processed_tensor = None
            
            # 方法1: 真正调用ComfyUI节点的处理函数
            if node_type:
                try:
                    # 尝试多种方式获取节点映射
                    node_mappings = None
                    
                    # 方式1: 从execution模块导入
                    try:
                        from execution import NODE_CLASS_MAPPINGS
                        node_mappings = NODE_CLASS_MAPPINGS
                    except ImportError:
                        pass
                    
                    # 方式2: 从server模块获取
                    if not node_mappings:
                        try:
                            from server import PromptServer
                            if hasattr(PromptServer, 'instance'):
                                # 尝试从PromptServer获取
                                if hasattr(PromptServer.instance, 'NODE_CLASS_MAPPINGS'):
                                    node_mappings = PromptServer.instance.NODE_CLASS_MAPPINGS
                                elif hasattr(PromptServer.instance, 'nodes'):
                                    # 尝试从nodes属性获取
                                    nodes_attr = getattr(PromptServer.instance, 'nodes', {})
                                    if isinstance(nodes_attr, dict) and 'NODE_CLASS_MAPPINGS' in nodes_attr:
                                        node_mappings = nodes_attr['NODE_CLASS_MAPPINGS']
                        except:
                            pass
                    
                    # 方式3: 尝试全局导入
                    if not node_mappings:
                        try:
                            import sys
                            for module_name in list(sys.modules.keys()):
                                if 'execution' in module_name or 'nodes' in module_name:
                                    try:
                                        module = sys.modules[module_name]
                                        if hasattr(module, 'NODE_CLASS_MAPPINGS'):
                                            node_mappings = module.NODE_CLASS_MAPPINGS
                                            break
                                    except:
                                        continue
                        except:
                            pass
                    
                    # 如果找到节点类，真正调用它
                    if node_mappings and node_type in node_mappings:
                        node_class = node_mappings[node_type]
                        node_instance = node_class()
                        
                        # 获取节点的输入类型定义
                        if hasattr(node_instance, 'INPUT_TYPES'):
                            input_types = node_instance.INPUT_TYPES()
                            
                            # 获取处理函数名
                            func_name = None
                            if hasattr(node_instance, 'FUNCTION'):
                                func_name = node_instance.FUNCTION
                            else:
                                # 尝试常见的函数名
                                for common_name in ['execute', 'process', 'run', 'apply', 'transform']:
                                    if hasattr(node_instance, common_name):
                                        func_name = common_name
                                        break
                            
                            if func_name and hasattr(node_instance, func_name):
                                func = getattr(node_instance, func_name)
                                
                                # 构建调用参数
                                call_params = {}
                                
                                # 处理required参数
                                if "required" in input_types:
                                    for req_key, req_type in input_types["required"].items():
                                        # 跳过hidden参数（如unique_id）
                                        if req_key == "unique_id" or "UNIQUE_ID" in str(req_type):
                                            continue
                                        
                                        if req_key == "image" or "IMAGE" in str(req_type):
                                            # 图像参数 - 直接传入tensor
                                            call_params[req_key] = tensor_image
                                        else:
                                            # 尝试从params中获取参数值（支持中文参数名）
                                            param_value = None
                                            
                                            # 方式1: 直接匹配键名
                                            if req_key in params:
                                                param_value = params[req_key]
                                            else:
                                                # 方式2: 尝试大小写不敏感匹配
                                                req_key_lower = req_key.lower()
                                                for param_key, param_val in params.items():
                                                    if param_key.lower() == req_key_lower:
                                                        param_value = param_val
                                                        break
                                            
                                            # 如果还是没找到，尝试使用默认值（如果有）
                                            if param_value is None:
                                                # 检查INPUT_TYPES中是否有默认值
                                                if isinstance(req_type, tuple) and len(req_type) > 1:
                                                    if isinstance(req_type[1], dict) and "default" in req_type[1]:
                                                        param_value = req_type[1]["default"]
                                            
                                            if param_value is not None:
                                                # 根据类型转换
                                                if isinstance(req_type, tuple) and len(req_type) > 0:
                                                    type_name = str(req_type[0])
                                                    if "FLOAT" in type_name or "float" in type_name:
                                                        try:
                                                            call_params[req_key] = float(param_value)
                                                        except:
                                                            call_params[req_key] = param_value
                                                    elif "INT" in type_name or "int" in type_name:
                                                        try:
                                                            call_params[req_key] = int(param_value)
                                                        except:
                                                            call_params[req_key] = param_value
                                                    elif "BOOLEAN" in type_name or "bool" in type_name:
                                                        call_params[req_key] = bool(param_value)
                                                    elif "STRING" in type_name or "str" in type_name:
                                                        call_params[req_key] = str(param_value)
                                                    else:
                                                        # 未知类型，尝试直接使用
                                                        call_params[req_key] = param_value
                                                else:
                                                    # 没有类型信息，直接使用
                                                    call_params[req_key] = param_value
                                
                                # 处理optional参数（如果有）
                                if "optional" in input_types:
                                    for opt_key, opt_type in input_types["optional"].items():
                                        if opt_key in params and opt_key not in call_params:
                                            # 同样处理类型转换
                                            param_value = params[opt_key]
                                            if isinstance(opt_type, tuple) and len(opt_type) > 0:
                                                type_name = str(opt_type[0])
                                                if "FLOAT" in type_name:
                                                    try:
                                                        call_params[opt_key] = float(param_value)
                                                    except:
                                                        call_params[opt_key] = param_value
                                                elif "INT" in type_name:
                                                    try:
                                                        call_params[opt_key] = int(param_value)
                                                    except:
                                                        call_params[opt_key] = param_value
                                                else:
                                                    call_params[opt_key] = param_value
                                            else:
                                                call_params[opt_key] = param_value
                                
                                # 如果required参数中没有image，但params中有，也添加
                                if "image" not in call_params and "image" in params:
                                    call_params["image"] = tensor_image
                                
                                # 调试信息
                                print(f"[ImagePreview] 调用节点 {node_type}, 函数: {func_name}, 参数: {list(call_params.keys())}")
                                
                                # 调用节点的真实处理函数
                                try:
                                    result = func(**call_params)
                                    
                                    # 处理返回值
                                    if result is not None:
                                        if isinstance(result, tuple):
                                            # 返回元组，取第一个元素（通常是IMAGE）
                                            if len(result) > 0:
                                                processed_tensor = result[0]
                                                # 确保是tensor格式
                                                if not isinstance(processed_tensor, torch.Tensor):
                                                    try:
                                                        processed_tensor = torch.tensor(processed_tensor, dtype=torch.float32)
                                                    except:
                                                        processed_tensor = None
                                        elif isinstance(result, torch.Tensor):
                                            # 直接返回tensor
                                            processed_tensor = result
                                        else:
                                            # 尝试转换
                                            try:
                                                if hasattr(result, 'to'):
                                                    processed_tensor = result.to(torch.float32)
                                                elif hasattr(result, 'cpu'):
                                                    # numpy数组或其他格式
                                                    processed_tensor = torch.from_numpy(result).float()
                                                else:
                                                    processed_tensor = torch.tensor(result, dtype=torch.float32)
                                            except Exception as e:
                                                print(f"[ImagePreview] 返回值转换失败: {e}")
                                                processed_tensor = None
                                        
                                        # 验证tensor格式
                                        if processed_tensor is not None:
                                            if not isinstance(processed_tensor, torch.Tensor):
                                                processed_tensor = None
                                            elif len(processed_tensor.shape) < 3:
                                                # 确保是 [B, H, W, C] 格式
                                                processed_tensor = None
                                        
                                        if processed_tensor is not None:
                                            print(f"[ImagePreview] 节点 {node_type} 执行成功，返回shape: {processed_tensor.shape}")
                                    
                                except Exception as e:
                                    import traceback
                                    print(f"[ImagePreview] 节点 {node_type} 执行失败: {e}")
                                    traceback.print_exc()
                                    
                except Exception as e:
                    import traceback
                    print(f"[ImagePreview] 无法调用节点类 {node_type}: {e}")
                    traceback.print_exc()
            
            # 方法2: 如果节点调用失败，尝试使用通用图像处理（作为fallback）
            if processed_tensor is None:
                print(f"[ImagePreview] 节点 {node_type} 调用失败，使用通用图像处理作为fallback")
                processed_img = img_array.copy().astype(np.float32)
                
                # 尝试导入OpenCV（可选）
                try:
                    import cv2
                    use_cv2 = True
                except ImportError:
                    use_cv2 = False
                
                # 应用参数进行通用图像处理（简化版本）
                for param_name, param_value in params.items():
                    try:
                        value = float(param_value)
                        
                        # 跳过无效值
                        if abs(value) < 0.0001 or abs(value - 1.0) < 0.0001:
                            continue
                        
                        # 1. 亮度调整（乘法变换）
                        if 0.1 <= abs(value) <= 10.0:
                            factor = value if value > 0 else 1.0 / abs(value) if abs(value) > 0.1 else 1.0
                            factor = np.clip(factor, 0.1, 10.0)
                            processed_img = processed_img * factor
                        
                        # 2. 对比度调整（偏移变换）
                        if abs(value) > 0.01:
                            offset = value * 0.3
                            processed_img = processed_img + offset
                        
                        # 3. HSV空间调整（可选，需要OpenCV）
                        if use_cv2 and abs(value) > 0.01:
                            try:
                                img_uint8 = np.clip(processed_img, 0, 255).astype(np.uint8)
                                hsv = cv2.cvtColor(img_uint8, cv2.COLOR_RGB2HSV).astype(np.float32)
                                # 饱和度调整
                                sat_factor = 1.0 + (value % 2.0) * 0.15
                                hsv[:, :, 1] = np.clip(hsv[:, :, 1] * sat_factor, 0, 255)
                                # 色相调整
                                hue_shift = (value % 180) * 0.1
                                hsv[:, :, 0] = (hsv[:, :, 0] + hue_shift) % 180
                                processed_img = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2RGB).astype(np.float32)
                            except Exception:
                                pass
                        
                        # 4. 锐化效果（可选，需要OpenCV）
                        if use_cv2 and abs(value) > 0.1:
                            try:
                                img_uint8 = np.clip(processed_img, 0, 255).astype(np.uint8)
                                kernel_strength = min(abs(value) * 0.05, 0.5)
                                kernel = np.array([[0, -0.3, 0], [-0.3, 2.2, -0.3], [0, -0.3, 0]]) * kernel_strength
                                processed_img = cv2.filter2D(img_uint8, -1, kernel).astype(np.float32)
                            except Exception:
                                pass
                        
                        # 限制到有效范围
                        processed_img = np.clip(processed_img, 0, 255)
                    
                    except (ValueError, TypeError):
                        continue
                
                # 转换为uint8并生成tensor
                processed_img = processed_img.astype(np.uint8)
                processed_tensor = torch.from_numpy(processed_img.astype(np.float32) / 255.0).unsqueeze(0)
            
            # 转换回图像格式
            if processed_tensor is not None:
                processed_array = (torch.clamp(processed_tensor, 0, 1) * 255).cpu().numpy().astype(np.uint8)[0]
            else:
                processed_array = img_array
            
            # 性能优化：如果使用了缩略图，保持缩略图尺寸（不需要缩放回原尺寸）
            # 对于预览来说，缩略图已经足够清晰
            original_width = data.get("original_width")
            original_height = data.get("original_height")
            scale_factor = data.get("scale_factor", 1.0)
            
            # 转换为base64返回（使用JPEG格式降低数据量）
            pil_result = Image.fromarray(processed_array)
            buffer = io.BytesIO()
            
            # 使用JPEG格式和质量压缩（性能优化）
            if pil_result.mode == 'RGBA':
                # RGBA需要转换为RGB
                rgb_result = Image.new('RGB', pil_result.size, (255, 255, 255))
                rgb_result.paste(pil_result, mask=pil_result.split()[3])
                rgb_result.save(buffer, format="JPEG", quality=85, optimize=True)
            else:
                pil_result.save(buffer, format="JPEG", quality=85, optimize=True)
            
            base64_result = base64.b64encode(buffer.getvalue()).decode('utf-8')
            
            return web.json_response({
                "success": True,
                "image_data": f"data:image/jpeg;base64,{base64_result}",
                "width": processed_array.shape[1],
                "height": processed_array.shape[0],
                "original_width": original_width,
                "original_height": original_height,
                "scale_factor": scale_factor
            })
            
        except Exception as e:
            import traceback
            traceback.print_exc()
            return web.json_response({
                "success": False,
                "error": str(e)
            }, status=500)
            
    except Exception as e:
        import traceback
        traceback.print_exc()
        return web.json_response({
            "success": False,
            "error": str(e)
        }, status=500)

@PromptServer.instance.routes.post("/image_preview/process_chain")
async def process_image_preview_chain(request):
    """处理节点链的API，支持依次处理多个上游节点"""
    try:
        data = await request.json()
        image_data = data.get("image_data")  # base64 图像数据
        chain = data.get("chain", [])  # 节点链信息
        
        if not chain or len(chain) == 0:
            return web.json_response({
                "success": False,
                "error": "节点链为空"
            }, status=400)
        
        try:
            # 解析图像数据
            if isinstance(image_data, str):
                if image_data.startswith("data:image"):
                    image_data = image_data.split(",")[1]
                image_bytes = base64.b64decode(image_data)
                pil_image = Image.open(io.BytesIO(image_bytes))
                img_array = np.array(pil_image)
            else:
                raise ValueError("不支持的图像数据格式")
            
            # 转换为torch tensor格式 (ComfyUI格式)
            if len(img_array.shape) == 3:
                tensor_image = torch.from_numpy(img_array.astype(np.float32) / 255.0).unsqueeze(0)
            else:
                raise ValueError("不支持的图像格式")
            
            # 依次处理节点链（从最上游到最下游）
            current_tensor = tensor_image
            
            # 获取节点映射
            node_mappings = None
            try:
                from execution import NODE_CLASS_MAPPINGS
                node_mappings = NODE_CLASS_MAPPINGS
            except ImportError:
                try:
                    from server import PromptServer
                    if hasattr(PromptServer, 'instance'):
                        if hasattr(PromptServer.instance, 'NODE_CLASS_MAPPINGS'):
                            node_mappings = PromptServer.instance.NODE_CLASS_MAPPINGS
                except:
                    pass
            
            if not node_mappings:
                import sys
                for module_name in list(sys.modules.keys()):
                    if 'execution' in module_name or 'nodes' in module_name:
                        try:
                            module = sys.modules[module_name]
                            if hasattr(module, 'NODE_CLASS_MAPPINGS'):
                                node_mappings = module.NODE_CLASS_MAPPINGS
                                break
                        except:
                            continue
            
            # 依次处理每个节点
            for node_info in chain:
                node_type = node_info.get("type", "")
                params = node_info.get("params", {})
                
                if not node_type or not node_mappings or node_type not in node_mappings:
                    print(f"[ImagePreview] 跳过未知节点类型: {node_type}")
                    continue
                
                try:
                    node_class = node_mappings[node_type]
                    node_instance = node_class()
                    
                    if hasattr(node_instance, 'INPUT_TYPES'):
                        input_types = node_instance.INPUT_TYPES()
                        
                        # 获取处理函数名
                        func_name = None
                        if hasattr(node_instance, 'FUNCTION'):
                            func_name = node_instance.FUNCTION
                        else:
                            for common_name in ['execute', 'process', 'run', 'apply', 'transform']:
                                if hasattr(node_instance, common_name):
                                    func_name = common_name
                                    break
                        
                        if func_name and hasattr(node_instance, func_name):
                            func = getattr(node_instance, func_name)
                            
                            # 构建调用参数
                            call_params = {}
                            
                            if "required" in input_types:
                                for req_key, req_type in input_types["required"].items():
                                    if req_key == "unique_id" or "UNIQUE_ID" in str(req_type):
                                        continue
                                    
                                    if req_key == "image" or "IMAGE" in str(req_type):
                                        call_params[req_key] = current_tensor
                                    else:
                                        param_value = None
                                        if req_key in params:
                                            param_value = params[req_key]
                                        else:
                                            req_key_lower = req_key.lower()
                                            for param_key, param_val in params.items():
                                                if param_key.lower() == req_key_lower:
                                                    param_value = param_val
                                                    break
                                        
                                        if param_value is None:
                                            if isinstance(req_type, tuple) and len(req_type) > 1:
                                                if isinstance(req_type[1], dict) and "default" in req_type[1]:
                                                    param_value = req_type[1]["default"]
                                        
                                        if param_value is not None:
                                            if isinstance(req_type, tuple) and len(req_type) > 0:
                                                type_name = str(req_type[0])
                                                if "FLOAT" in type_name or "float" in type_name:
                                                    try:
                                                        call_params[req_key] = float(param_value)
                                                    except:
                                                        call_params[req_key] = param_value
                                                elif "INT" in type_name or "int" in type_name:
                                                    try:
                                                        call_params[req_key] = int(param_value)
                                                    except:
                                                        call_params[req_key] = param_value
                                                elif "BOOLEAN" in type_name or "bool" in type_name:
                                                    call_params[req_key] = bool(param_value)
                                                elif "STRING" in type_name or "str" in type_name:
                                                    call_params[req_key] = str(param_value)
                                                else:
                                                    call_params[req_key] = param_value
                                            else:
                                                call_params[req_key] = param_value
                            
                            # 调用节点处理函数
                            result = func(**call_params)
                            
                            # 处理返回值
                            if result is not None:
                                if isinstance(result, tuple):
                                    if len(result) > 0:
                                        current_tensor = result[0]
                                elif isinstance(result, torch.Tensor):
                                    current_tensor = result
                                else:
                                    try:
                                        if hasattr(result, 'to'):
                                            current_tensor = result.to(torch.float32)
                                        elif hasattr(result, 'cpu'):
                                            current_tensor = torch.from_numpy(result).float()
                                        else:
                                            current_tensor = torch.tensor(result, dtype=torch.float32)
                                    except:
                                        print(f"[ImagePreview] 节点 {node_type} 返回值转换失败")
                                        continue
                                
                                # 验证tensor格式
                                if not isinstance(current_tensor, torch.Tensor) or len(current_tensor.shape) < 3:
                                    print(f"[ImagePreview] 节点 {node_type} 返回的tensor格式无效")
                                    continue
                                
                                print(f"[ImagePreview] 节点 {node_type} 处理成功，tensor shape: {current_tensor.shape}")
                            else:
                                print(f"[ImagePreview] 节点 {node_type} 返回None，跳过")
                                continue
                        else:
                            print(f"[ImagePreview] 节点 {node_type} 没有找到处理函数")
                            continue
                    else:
                        print(f"[ImagePreview] 节点 {node_type} 没有INPUT_TYPES")
                        continue
                        
                except Exception as e:
                    import traceback
                    print(f"[ImagePreview] 节点 {node_type} 处理失败: {e}")
                    traceback.print_exc()
                    continue
            
            # 转换回图像格式
            processed_array = (torch.clamp(current_tensor, 0, 1) * 255).cpu().numpy().astype(np.uint8)[0]
            
            # 转换为base64返回
            pil_result = Image.fromarray(processed_array)
            buffer = io.BytesIO()
            
            if pil_result.mode == 'RGBA':
                rgb_result = Image.new('RGB', pil_result.size, (255, 255, 255))
                rgb_result.paste(pil_result, mask=pil_result.split()[3])
                rgb_result.save(buffer, format="JPEG", quality=85, optimize=True)
            else:
                pil_result.save(buffer, format="JPEG", quality=85, optimize=True)
            
            base64_result = base64.b64encode(buffer.getvalue()).decode('utf-8')
            
            return web.json_response({
                "success": True,
                "image_data": f"data:image/jpeg;base64,{base64_result}",
                "width": processed_array.shape[1],
                "height": processed_array.shape[0],
                "original_width": data.get("original_width"),
                "original_height": data.get("original_height"),
                "scale_factor": data.get("scale_factor", 1.0)
            })
            
        except Exception as e:
            import traceback
            traceback.print_exc()
            return web.json_response({
                "success": False,
                "error": str(e)
            }, status=500)
            
    except Exception as e:
        import traceback
        traceback.print_exc()
        return web.json_response({
            "success": False,
            "error": str(e)
        }, status=500)

NODE_CLASS_MAPPINGS = {
    "ImagePreviewNode": ImagePreviewNode,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ImagePreviewNode": "🔵BB 实时预览",
}

