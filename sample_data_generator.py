import csv
import random
from datetime import datetime, timedelta

# Configuration
products = [f"Product {i+1}" for i in range(15)]
start_date = datetime(2022, 1, 1)
end_date = datetime(2025, 1, 1)

# Generate month/year values
def get_months(start, end):
    months = []
    current = start
    while current < end:
        months.append(current.strftime("%m/%d/%Y"))
        # Advance one month
        current = current.replace(day=28) + timedelta(days=4)
        current = current.replace(day=1)
    return months

months = get_months(start_date, end_date)

# Generate sales data
data = []
for month in months:
    for product in products:
        unit_price = round(random.uniform(5, 50), 2)
        quantity = random.randint(50, 500)
        sales = round(unit_price * quantity, 2)
        data.append([month, product, unit_price, quantity, sales])

# Write to CSV
with open("sales_data2.csv", "w", newline="") as file:
    writer = csv.writer(file)
    writer.writerow(["month/year", "product name", "unit price", "quantity", "sales amount"])
    writer.writerows(data)

print("✅ sales_data.csv generated with 3 years of sample data.")
