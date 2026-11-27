# firmware

控制与嵌入式 Agent 的目录，PlatformIO 工程放在这里。

- `platformio.ini`、`src/`、`include/`、`test/`：固件工程
- `sim/`：控制算法的仿真脚本
- `logs/`：保存下来的串口日志
- 引脚定义集中放在一个头文件里，数值取自 `elec/pinmap.csv`
