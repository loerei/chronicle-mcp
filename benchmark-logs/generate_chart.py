import os
import matplotlib.pyplot as plt
import numpy as np

# Data for PRD and Tickets Resolution Benchmark
# Model: Gemini 3.7 Flash (High)
# Task: Find all PRDs created by /to-prd and all tickets created by /to-tickets, check applied status
metrics = ["Task Achievement", "Steps", "Tool Calls", "Execution Time (s)", "Output Tokens", "Peak Context"]

variant_a = [1.0, 85, 38, 119.0, 9097, 82503]
variant_b = [1.0, 128, 56, 259.0, 25424, 62246]

plt.style.use('dark_background')
fig, (ax1, ax2, ax3) = plt.subplots(1, 3, figsize=(18, 5))
fig.suptitle("Chronicle MCP vs Custom Scripts Benchmark (Gemini 3.7 Flash High)", fontsize=14, fontweight='bold', color='#e0e0e0', y=0.98)

color_a = '#69f0ae'  # Soft green (Chronicle MCP)
color_b = '#ff5252'  # Soft red (Custom Scripts)

categories = ["Variant A\n(Chronicle MCP)", "Variant B\n(Custom Scripts)"]

# Plot 1: Execution Time (Seconds)
times = [119.0, 259.0]
bars1 = ax1.bar(categories, times, color=[color_a, color_b], width=0.5)
ax1.set_title("Execution Time (Seconds) - Lower is Better", fontsize=11, color='#b0b0b0', pad=10)
ax1.set_ylabel("Time (s)", fontsize=10, color='#b0b0b0')
ax1.grid(True, linestyle='--', alpha=0.2, color='#444444', axis='y')
ax1.tick_params(colors='#b0b0b0')
ax1.set_ylim(0, 300)
for bar in bars1:
    yval = bar.get_height()
    ax1.text(bar.get_x() + bar.get_width()/2.0, yval + 8, f"{yval:.1f}s", ha='center', va='bottom', color='#e0e0e0', fontweight='bold')
ax1.text(0.5, 0.85, "2.18x Faster", transform=ax1.transAxes, ha='center', color='#69f0ae', fontsize=12, fontweight='bold')

# Plot 2: Steps and Tool Calls
x = np.arange(len(categories))
width = 0.3
steps = [85, 128]
tools = [38, 56]
rects1 = ax2.bar(x - width/2, steps, width, label='Agent Steps', color='#4fc3f7')
rects2 = ax2.bar(x + width/2, tools, width, label='Tool Calls', color='#ba68c8')
ax2.set_title("Agent Steps & Tool Calls - Lower is Better", fontsize=11, color='#b0b0b0', pad=10)
ax2.set_xticks(x)
ax2.set_xticklabels(categories)
ax2.grid(True, linestyle='--', alpha=0.2, color='#444444', axis='y')
ax2.tick_params(colors='#b0b0b0')
ax2.legend(loc='upper right')
ax2.set_ylim(0, 150)
for bar in rects1:
    yval = bar.get_height()
    ax2.text(bar.get_x() + bar.get_width()/2.0, yval + 3, f"{int(yval)}", ha='center', va='bottom', color='#e0e0e0', fontsize=9)
for bar in rects2:
    yval = bar.get_height()
    ax2.text(bar.get_x() + bar.get_width()/2.0, yval + 3, f"{int(yval)}", ha='center', va='bottom', color='#e0e0e0', fontsize=9)
ax2.text(0.5, 0.85, "-33.6% Steps", transform=ax2.transAxes, ha='center', color='#4fc3f7', fontsize=12, fontweight='bold')

# Plot 3: Output Tokens Consumed
tokens_out = [9097, 25424]
bars3 = ax3.bar(categories, tokens_out, color=[color_a, color_b], width=0.5)
ax3.set_title("Output Tokens - Lower is Better", fontsize=11, color='#b0b0b0', pad=10)
ax3.set_ylabel("Tokens", fontsize=10, color='#b0b0b0')
ax3.grid(True, linestyle='--', alpha=0.2, color='#444444', axis='y')
ax3.tick_params(colors='#b0b0b0')
ax3.set_ylim(0, 30000)
for bar in bars3:
    yval = bar.get_height()
    ax3.text(bar.get_x() + bar.get_width()/2.0, yval + 800, f"{int(yval):,}", ha='center', va='bottom', color='#e0e0e0', fontweight='bold')
ax3.text(0.5, 0.85, "2.79x Less Output Tokens", transform=ax3.transAxes, ha='center', color='#69f0ae', fontsize=12, fontweight='bold')

plt.tight_layout()
output_dir = os.path.dirname(os.path.abspath(__file__))
output_file = os.path.join(output_dir, "prd-and-tickets", "prd-tickets-benchmark-chart.png")
os.makedirs(os.path.dirname(output_file), exist_ok=True)
plt.savefig(output_file, dpi=200, bbox_inches='tight')
print(f"Chart successfully saved to: {output_file}")
