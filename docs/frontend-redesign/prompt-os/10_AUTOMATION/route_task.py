import sys
text=' '.join(sys.argv[1:]).lower()
routes=[]
checks=[
 ('marketing',['landing','homepage','pricing','login','marketing']),
 ('workspace',['dashboard','overview','product','inventory','order','customer']),
 ('onboarding',['onboarding','readiness','publish']),
 ('domain',['domain','dns','ssl','hostname']),
 ('storefront',['storefront','checkout','cart','buyer','product detail','key reveal']),
 ('admin',['admin','incident','abuse','operations']),
 ('design-system',['token','component','typography','color','design system']),
 ('visual-qa',['visual','pixel','screenshot','responsive','accessibility'])]
for name,words in checks:
  if any(w in text for w in words): routes.append(name)
print('\n'.join(routes or ['design-system']))
