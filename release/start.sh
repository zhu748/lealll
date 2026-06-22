#!/usr/bin/env bash

echo ""
echo "============================================"
echo "         zcode-proxy 管理工具"
echo "============================================"
echo ""
echo "  1. 启动代理服务"
echo "  2. OAuth 登录 (智谱 Bigmodel)"
echo "  3. OAuth 登录 (Z.AI)"
echo "  4. 从 ZCode 导入密钥 (智谱)"
echo "  5. 从 ZCode 导入密钥 (Z.AI)"
echo "  6. 查看登录状态"
echo "  7. 退出登录"
echo "  0. 退出"
echo ""
read -p "请输入选项: " choice

case $choice in
  1)
    echo ""
    echo "=============================="
    echo "  zcode-proxy 启动中..."
    echo "=============================="
    echo ""
    chmod +x zcode-proxy.exe
    ./zcode-proxy.exe serve --config config.yaml
    ;;
  2)
    echo ""
    echo "正在启动智谱 OAuth 登录..."
    echo "将自动打开浏览器，请完成授权..."
    echo ""
    ./zcode-proxy.exe auth login bigmodel
    ;;
  3)
    echo ""
    echo "正在启动 Z.AI OAuth 登录..."
    echo "将自动打开浏览器，请完成授权..."
    echo ""
    ./zcode-proxy.exe auth login zai
    ;;
  4)
    echo ""
    echo "正在从 ZCode 导入智谱密钥..."
    echo ""
    ./zcode-proxy.exe auth login bigmodel --import
    ;;
  5)
    echo ""
    echo "正在从 ZCode 导入 Z.AI 密钥..."
    echo ""
    ./zcode-proxy.exe auth login zai --import
    ;;
  6)
    echo ""
    ./zcode-proxy.exe auth status
    ;;
  7)
    echo ""
    ./zcode-proxy.exe auth logout
    ;;
  0)
    exit 0
    ;;
  *)
    echo "无效选项"
    ;;
esac
