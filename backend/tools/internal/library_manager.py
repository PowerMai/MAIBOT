"""
库管理器 - 简化版

设计原则：
1. 不维护庞大的库清单
2. 按需检测和安装
3. 简单直接
"""

import importlib
import subprocess
import sys
from typing import Optional
import logging

logger = logging.getLogger(__name__)


def is_library_available(name: str) -> bool:
    """检查库是否可用"""
    try:
        importlib.import_module(name)
        return True
    except ImportError:
        return False


def install_library(name: str) -> bool:
    """安装库（同步）"""
    try:
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", name, "-q"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return True
    except subprocess.CalledProcessError:
        return False


def ensure_library(name: str, auto_install: bool = True) -> bool:
    """确保库可用，必要时安装"""
    if is_library_available(name):
        return True
    
    if auto_install:
        logger.info(f"安装库: {name}")
        if install_library(name):
            return is_library_available(name)
    
    return False


# 兼容性别名
class LibraryManager:
    """兼容性包装器"""
    
    @staticmethod
    def is_available(name: str) -> bool:
        return is_library_available(name)
    
    @staticmethod
    def ensure(name: str, auto_install: bool = True) -> bool:
        return ensure_library(name, auto_install)


library_manager = LibraryManager()

__all__ = [
    "is_library_available",
    "install_library", 
    "ensure_library",
    "library_manager",
]
