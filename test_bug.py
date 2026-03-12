import requests

projects = requests.get('http://127.0.0.1:8000/projects').json()
project_id = projects[0]['id']

recordings = requests.get(f'http://127.0.0.1:8000/projects/{project_id}').json()['recordings']
recording_id = recordings[0]['id']

print(f"Recording: {recording_id}")

runs = requests.get(f'http://127.0.0.1:8000/recordings/{recording_id}').json()['runs']
run_id = runs[0]['id']
print(f"Run {run_id} progress in recordings list: {runs[0]['progress']}")

run_detail = requests.get(f'http://127.0.0.1:8000/runs/{run_id}').json()
print(f"Run {run_id} progress in run detail: {run_detail['summary']['progress']}")
