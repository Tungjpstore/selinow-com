from pathlib import Path
import json, sys
root = Path(__file__).resolve().parents[1]
required = [
  'AGENTS.md','PROMPT_OS_MANIFEST.yaml','00_START_HERE/ONE_SHOT_AGENT_PROMPT.md',
  '03_DESIGN_SYSTEM/selinow-frontend-tokens.css','06_COPY_DECK/vi-VN.json',
  '09_QA/ROUTE_ACCEPTANCE_MATRIX.csv','13_REFERENCE_ASSETS/REFERENCE_INDEX.md'
]
missing=[x for x in required if not (root/x).exists()]
if missing:
  print('Missing:', *missing, sep='\n- '); sys.exit(1)
json.load(open(root/'06_COPY_DECK/vi-VN.json',encoding='utf-8'))
json.load(open(root/'04_COMPONENT_SYSTEM/component-manifest.json',encoding='utf-8'))
print('Prompt OS structure valid.')
